"""SauceBoss URL import route — scrapes a recipe URL and returns a parsed draft sauce."""

import re
from fractions import Fraction
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException
from pydantic import BaseModel, HttpUrl

from db import get_supabase
from . import router

# ── Request / response models ─────────────────────────────────────────────────

class ImportUrlRequest(BaseModel):
    url: str


class ImportedIngredient(BaseModel):
    name: str
    amount: float
    unit: str
    unit_type: str
    original_text: str


class ImportedStep(BaseModel):
    title: str
    ingredients: list[ImportedIngredient]


class ImportUrlResponse(BaseModel):
    name: str
    description: str
    cuisine: str
    servings: Optional[int]
    yield_quantity: Optional[float]
    yield_unit: Optional[str]
    source_url: str
    source_name: str
    steps: list[ImportedStep]
    confidence: float


# ── Unit resolution ───────────────────────────────────────────────────────────

# Unicode fraction characters → ASCII equivalents
_FRACTION_CHARS: dict[str, str] = {
    '½': '1/2', '¼': '1/4', '¾': '3/4',
    '⅓': '1/3', '⅔': '2/3', '⅛': '1/8', '⅜': '3/8',
}

# Common long-form unit names → SauceBoss abbreviations
_UNIT_ALIASES: dict[str, str] = {
    'tablespoon': 'tbsp', 'tablespoons': 'tbsp', 'tbsps': 'tbsp', 'tbs': 'tbsp',
    'teaspoon': 'tsp', 'teaspoons': 'tsp', 'tsps': 'tsp',
    'cup': 'cup', 'cups': 'cup',
    'ounce': 'oz', 'ounces': 'oz', 'fl oz': 'oz', 'fluid ounce': 'oz', 'fluid ounces': 'oz',
    'milliliter': 'ml', 'milliliters': 'ml', 'millilitre': 'ml', 'millilitres': 'ml',
    'gram': 'g', 'grams': 'g',
    'clove': 'clove', 'cloves': 'cloves',
    'pinch': 'pinch', 'pinches': 'pinch',
    'piece': 'piece', 'pieces': 'pieces',
}

# Module-level cache — loaded once on first import request
_units_cache: dict[str, dict] | None = None


def _load_units_cache() -> dict[str, dict]:
    """Fetch units from DB and build a lookup dict keyed by abbreviation and display_name."""
    global _units_cache
    if _units_cache is not None:
        return _units_cache
    try:
        sb = get_supabase()
        result = sb.table("sauceboss_units").select("*").execute()
        rows = result.data or []
    except Exception:
        rows = []

    cache: dict[str, dict] = {}
    for u in rows:
        cache[u["abbreviation"].lower()] = u
        cache[u["display_name"].lower()] = u
    _units_cache = cache
    return cache


def _resolve_unit(raw: str) -> tuple[str, str]:
    """Map a raw unit string to (abbreviation, unit_type). Returns ('piece','count') on failure."""
    if not raw:
        return "piece", "count"

    lower = raw.strip().lower()
    units = _load_units_cache()

    # 1. Direct DB match
    if lower in units:
        u = units[lower]
        return u["abbreviation"], u["unit_type"]

    # 2. Static alias lookup
    alias = _UNIT_ALIASES.get(lower)
    if alias and alias in units:
        u = units[alias]
        return u["abbreviation"], u["unit_type"]

    # 3. Fuzzy match via rapidfuzz
    try:
        from rapidfuzz import process, fuzz
        candidates = list(units.keys())
        result = process.extractOne(lower, candidates, scorer=fuzz.ratio, score_cutoff=70)
        if result:
            u = units[result[0]]
            return u["abbreviation"], u["unit_type"]
    except ImportError:
        pass

    return "piece", "count"


# ── Ingredient string parser ──────────────────────────────────────────────────

_QUANTITY_PATTERN = re.compile(
    r'^'
    r'(?:(\d+)\s+)?'        # optional whole number (e.g. "1 " in "1 1/2")
    r'(\d+/\d+|[\d.]+)?'    # fraction or decimal
    r'\s*'
)

_HTML_TAG = re.compile(r'<[^>]+>')
_MULTI_SPACE = re.compile(r'\s{2,}')
_PREP_NOTE = re.compile(r',\s*.+$')  # strip trailing prep notes: ", finely chopped"


def _clean_string(s: str) -> str:
    s = _HTML_TAG.sub('', s)
    s = _MULTI_SPACE.sub(' ', s)
    return s.strip()


def _parse_quantity(text: str) -> tuple[float, str]:
    """Extract leading quantity from text. Returns (quantity, remainder)."""
    for char, replacement in _FRACTION_CHARS.items():
        text = text.replace(char, replacement)

    # "1 1/2 cups ..." → whole + fraction
    m = re.match(r'^(\d+)\s+(\d+/\d+)\s+(.*)', text)
    if m:
        return int(m.group(1)) + float(Fraction(m.group(2))), m.group(3)

    # "1/2 cup ..."
    m = re.match(r'^(\d+/\d+)\s+(.*)', text)
    if m:
        return float(Fraction(m.group(1))), m.group(2)

    # "1.5 tbsp ..."
    m = re.match(r'^(\d+\.?\d*)\s+(.*)', text)
    if m:
        return float(m.group(1)), m.group(2)

    # No quantity found
    return 1.0, text


def _parse_ingredient(raw: str) -> ImportedIngredient:
    """Parse a raw ingredient string into structured fields."""
    cleaned = _clean_string(raw)
    qty, remainder = _parse_quantity(cleaned)

    # First token of remainder = candidate unit
    tokens = remainder.strip().split()
    if not tokens:
        return ImportedIngredient(name=cleaned, amount=qty, unit='piece',
                                  unit_type='count', original_text=raw)

    candidate_unit = tokens[0].rstrip('.')
    abbr, unit_type = _resolve_unit(candidate_unit)

    # If unit was resolved, food name is rest of tokens
    if abbr != 'piece' or candidate_unit.lower() in ('piece', 'pieces'):
        food_tokens = tokens[1:]
    else:
        # Unit not recognized — treat whole remainder as food name, default unit
        food_tokens = tokens
        abbr = 'piece'
        unit_type = 'count'

    food_name = ' '.join(food_tokens)
    # Strip trailing prep note (", minced", ", roughly chopped")
    food_name = _PREP_NOTE.sub('', food_name).strip()
    if not food_name:
        food_name = cleaned

    return ImportedIngredient(
        name=food_name,
        amount=qty,
        unit=abbr,
        unit_type=unit_type,
        original_text=raw,
    )


# ── Step grouping ─────────────────────────────────────────────────────────────

def _group_into_steps(
    ingredients: list[ImportedIngredient],
    instructions: list[str],
) -> list[ImportedStep]:
    """Assign ingredients to steps based on name mentions in instructions.

    Falls back to a single 'Ingredients' step if matching fails.
    """
    if not instructions:
        return [ImportedStep(title="Ingredients", ingredients=ingredients)]

    steps: list[ImportedStep] = []
    assigned: set[int] = set()

    for idx, instruction in enumerate(instructions):
        inst_lower = instruction.lower()
        step_ings: list[ImportedIngredient] = []
        for i, ing in enumerate(ingredients):
            if i in assigned:
                continue
            # Check if any word from ingredient name appears in instruction
            name_words = [w for w in ing.name.lower().split() if len(w) > 2]
            if any(word in inst_lower for word in name_words):
                step_ings.append(ing)
                assigned.add(i)

        title = f"Step {idx + 1}"
        # Use first sentence of instruction as step title (max 50 chars)
        first_sentence = re.split(r'[.!]', instruction)[0].strip()
        if first_sentence:
            title = first_sentence[:50]

        if step_ings:
            steps.append(ImportedStep(title=title, ingredients=step_ings))

    # Remaining unassigned ingredients go into a first "Prep" step
    unassigned = [ing for i, ing in enumerate(ingredients) if i not in assigned]
    if unassigned:
        steps.insert(0, ImportedStep(title="Ingredients", ingredients=unassigned))

    if not steps:
        steps = [ImportedStep(title="Ingredients", ingredients=ingredients)]

    return steps


# ── Source name extraction ────────────────────────────────────────────────────

def _extract_source_name(url: str) -> str:
    """Convert a URL hostname into a readable site name."""
    try:
        hostname = urlparse(url).netloc.lower().replace('www.', '')
        domain = hostname.split('.')[0]
        return domain.replace('-', ' ').title()
    except Exception:
        return "Web"


# ── Servings parsing ──────────────────────────────────────────────────────────

def _parse_servings(yields_str: str | None) -> tuple[int | None, float | None, str | None]:
    """Parse a yields string like '4 servings' or '2 cups' into (servings, qty, unit)."""
    if not yields_str:
        return None, None, None

    yields_str = yields_str.strip()
    m = re.match(r'^(\d+\.?\d*)\s*(.*)$', yields_str)
    if not m:
        return None, None, None

    qty = float(m.group(1))
    label = m.group(2).strip().lower()

    if 'serving' in label or 'portion' in label or not label:
        return int(qty), None, None

    return int(qty), qty, label


# ── Main endpoint ─────────────────────────────────────────────────────────────

@router.post("/import-url", response_model=ImportUrlResponse, summary="Import sauce from URL")
async def import_url(body: ImportUrlRequest) -> ImportUrlResponse:
    """Scrape a recipe URL and return a parsed draft sauce — NOT saved to the database.
    The frontend pre-fills the sauce builder with the returned data for user review.
    """
    try:
        from recipe_scrapers import scrape_url, WebsiteNotImplementedError
        scraper = scrape_url(str(body.url), wild_mode=True)
    except ImportError:
        raise HTTPException(500, "recipe-scrapers package not installed")
    except Exception as e:
        raise HTTPException(422, f"Could not fetch or parse recipe from this URL: {str(e)}")

    # ── Extract raw fields ────────────────────────────────────────────────────
    try:
        raw_ingredients: list[str] = scraper.ingredients() or []
    except Exception:
        raw_ingredients = []

    try:
        instructions: list[str] = scraper.instructions_list() or []
    except Exception:
        instructions = []

    try:
        title: str = scraper.title() or ""
    except Exception:
        title = ""

    try:
        description: str = scraper.description() or ""
    except Exception:
        description = ""

    try:
        yields_raw: str | None = scraper.yields()
    except Exception:
        yields_raw = None

    if not raw_ingredients and not title:
        raise HTTPException(422, "Could not detect recipe content from this URL")

    # ── Parse ingredients ─────────────────────────────────────────────────────
    parsed_ings = [_parse_ingredient(r) for r in raw_ingredients if r.strip()]

    # ── Group into steps ──────────────────────────────────────────────────────
    steps = _group_into_steps(parsed_ings, instructions)

    # ── Parse servings ────────────────────────────────────────────────────────
    servings, yield_qty, yield_unit = _parse_servings(yields_raw)

    # ── Confidence score ──────────────────────────────────────────────────────
    confidence = 1.0
    if not instructions:
        confidence -= 0.2
    if len(parsed_ings) < 2:
        confidence -= 0.2
    unresolved = sum(1 for i in parsed_ings if i.unit == 'piece' and
                     not any(w in i.original_text.lower() for w in ('piece', 'pieces', 'whole')))
    confidence -= min(0.3, unresolved * 0.05)
    confidence = max(0.1, round(confidence, 2))

    return ImportUrlResponse(
        name=title,
        description=description,
        cuisine="",
        servings=servings,
        yield_quantity=yield_qty,
        yield_unit=yield_unit,
        source_url=str(body.url),
        source_name=_extract_source_name(str(body.url)),
        steps=steps,
        confidence=confidence,
    )
