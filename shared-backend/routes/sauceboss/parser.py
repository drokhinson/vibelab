"""URL → recipe parsing via ``recipe-scrapers`` (schema.org JSON-LD).

Mealie's pipeline tries multiple strategies (recipe-scrapers, OpenAI
fallback, Open Graph). For sauceboss v1 we only implement the schema.org
strategy — most major recipe sites publish JSON-LD, and this keeps us free
of LLM cost/latency.

Per-line ingredient splitting uses ``ingredient_parser`` (the same library
Mealie uses) to break "2 tbsp olive oil" into structured parts. We then run
the parsed quantity/unit through :mod:`units` to compute canonical
quantities so the import preview already has scaling-ready numbers.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import StrEnum

logger = logging.getLogger("sauceboss.parser")


class ScrapeErrorKind(StrEnum):
    INVALID_URL = "invalid_url"
    NETWORK = "network"
    NO_STRUCTURED_DATA = "no_structured_data"
    UNSUPPORTED_SITE = "unsupported_site"
    UNKNOWN = "unknown"


class ScrapeError(Exception):
    """Recipe scraping failed. ``kind`` lets the route emit the right HTTP error."""

    def __init__(self, kind: ScrapeErrorKind, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


# ── Ingredient name normalization ─────────────────────────────────────────────
#
# All ingredient names are stored lowercased so "Jalapeño", "jalapeño" and
# "JALAPEÑO" collapse to one row. Frontends capitalize for display via
# shared/text.js#capitalizeIngredient.
#
# Plural recognition is heuristic — try a few common English plural suffixes
# and accept the shortest form that already exists in the categories table.
# Falls back to the raw lowercased input when no singular form is known.


def _plural_candidates(name: str) -> list[str]:
    """Return ``name`` plus likely singular variants in priority order.

    Examples::

        "tomatoes" → ["tomatoes", "tomatoe", "tomato"]
        "berries"  → ["berries", "berry"]
        "leaves"   → ["leaves", "leave", "leav"]   (irregular; harmless if
                                                    none match the DB)
        "jalapeños" → ["jalapeños", "jalapeño"]
    """
    out = [name]
    if name.endswith("ies") and len(name) > 3:
        out.append(name[:-3] + "y")
    if name.endswith("es") and len(name) > 2:
        out.append(name[:-2])
        out.append(name[:-1])
    elif name.endswith("s") and len(name) > 1:
        out.append(name[:-1])
    return out


def _normalize_ingredient_name(raw: str, known_lower: set[str] | None) -> str:
    """Lowercase ``raw`` and singularize if a known form matches.

    ``known_lower`` is a set of already-lowercased ingredient names from the
    DB (loaded once per scrape). When None, just lowercases.
    """
    lower = (raw or "").strip().lower()
    if not lower or not known_lower:
        return lower
    for candidate in _plural_candidates(lower):
        if candidate in known_lower:
            return candidate
    return lower


def _load_known_ingredient_names() -> set[str] | None:
    """Pull every ingredient.name from Supabase as a lowercased set.

    Failure is non-fatal — return None so the parser falls back to plain
    lowercasing without DB-aware singularize.
    """
    try:
        from db import get_supabase

        sb = get_supabase()
        result = sb.table("sauceboss_ingredient").select("name").execute()
        return {str(row["name"]).strip().lower() for row in (result.data or []) if row.get("name")}
    except Exception:
        logger.exception("parser: could not load known ingredient names")
        return None


@dataclass
class ParsedIngredient:
    original_text: str
    quantity: float | None
    unit_raw: str | None
    food_raw: str
    canonical_ml: float | None
    canonical_g: float | None
    note: str | None
    modifier: str | None = None


@dataclass
class ParsedRecipe:
    name: str
    description: str
    total_time_minutes: int | None
    yield_servings: int | None
    instructions: list[str]
    ingredients: list[ParsedIngredient]
    source_url: str
    canonical_url: str | None
    fallback: bool = False


# ── recipe-scrapers + ingredient_parser are heavy deps; import lazily. ──────

def _scrape_html(url: str):
    """Wrap recipe_scrapers.scrape_me; map common failures to ScrapeError.

    The library's old ``wild_mode`` kwarg (best-effort scrape on unsupported
    sites) was removed in 15.x — sites must now be on the supported-sites
    list, which today covers ~500+ recipe domains. See
    https://docs.recipe-scrapers.com/getting-started/supported-sites/ or run
    ``from recipe_scrapers import SCRAPERS; sorted(SCRAPERS.keys())``.
    """
    try:
        from recipe_scrapers import scrape_me
        from recipe_scrapers._exceptions import (
            NoSchemaFoundInWildMode,
            SchemaOrgException,
            WebsiteNotImplementedError,
        )
    except ImportError as e:
        raise ScrapeError(ScrapeErrorKind.UNKNOWN, f"recipe-scrapers not installed: {e}")

    try:
        return scrape_me(url)
    except WebsiteNotImplementedError as e:
        raise ScrapeError(ScrapeErrorKind.UNSUPPORTED_SITE, str(e))
    except NoSchemaFoundInWildMode as e:
        raise ScrapeError(ScrapeErrorKind.NO_STRUCTURED_DATA, str(e))
    except SchemaOrgException as e:
        raise ScrapeError(ScrapeErrorKind.NO_STRUCTURED_DATA, str(e))
    except Exception as e:
        # recipe-scrapers can raise raw urllib/httpx errors for network issues.
        msg = str(e).lower()
        if any(s in msg for s in ("timed out", "connection", "name or service", "ssl", "dns")):
            raise ScrapeError(ScrapeErrorKind.NETWORK, str(e))
        raise ScrapeError(ScrapeErrorKind.UNKNOWN, f"{type(e).__name__}: {e}")


def _parse_ingredient_line(line: str) -> tuple[float | None, str | None, str, str | None]:
    """Split "2 tbsp olive oil" into (quantity, unit_raw, food_raw, note).

    Uses ingredient_parser_nlp when available, falls back to a regex split.
    """
    line = line.strip()
    if not line:
        return (None, None, "", None)

    try:
        from ingredient_parser import parse_ingredient
    except ImportError:
        return _regex_split_ingredient(line)

    try:
        result = parse_ingredient(line)
    except Exception:
        return _regex_split_ingredient(line)

    qty: float | None = None
    unit_raw: str | None = None
    food_raw: str = ""
    note: str | None = None

    amounts = getattr(result, "amount", None) or []
    if amounts:
        first = amounts[0]
        try:
            qty_val = getattr(first, "quantity", None)
            qty = float(qty_val) if qty_val is not None else None
        except (TypeError, ValueError):
            qty = None
        unit_obj = getattr(first, "unit", None)
        if unit_obj is not None:
            unit_raw = str(unit_obj).strip() or None

    name_obj = getattr(result, "name", None)
    if isinstance(name_obj, list) and name_obj:
        name_obj = name_obj[0]
    if name_obj is not None:
        food_raw = (getattr(name_obj, "text", None) or str(name_obj)).strip()

    comment = getattr(result, "comment", None)
    if comment:
        note = (getattr(comment, "text", None) or str(comment)).strip() or None

    if not food_raw:
        # Last-ditch fallback so we never emit a blank food.
        return _regex_split_ingredient(line)

    return (qty, unit_raw, food_raw, note)


_LEADING_QTY_RE = re.compile(
    r"^\s*(?P<qty>(?:\d+\s+\d+/\d+)|(?:\d+/\d+)|(?:\d+\.\d+)|\d+|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])"
    r"(?:\s*[-–~]\s*(?:\d+(?:\.\d+)?|\d+/\d+))?"
    r"\s*"
)


def _regex_split_ingredient(line: str) -> tuple[float | None, str | None, str, str | None]:
    """Plain-regex fallback when ingredient_parser is unavailable."""
    from .units import UNIT_REGISTRY, parse_quantity

    rest = line.strip()
    note: str | None = None

    # Pull a trailing parenthesised note if present, e.g. "1 cup flour (sifted)".
    paren = re.search(r"\(([^)]*)\)\s*$", rest)
    if paren:
        note = paren.group(1).strip() or None
        rest = rest[: paren.start()].strip()

    qty: float | None = None
    m = _LEADING_QTY_RE.match(rest)
    if m:
        qty = parse_quantity(m.group("qty"))
        rest = rest[m.end():].strip()

    unit_raw: str | None = None
    if rest:
        # Try matching the longest known unit alias at the start (case-insensitive).
        aliases = sorted(
            (a for u in UNIT_REGISTRY.values() for a in u.aliases),
            key=len,
            reverse=True,
        )
        lower = rest.lower()
        for alias in aliases:
            a = alias.lower()
            if lower.startswith(a) and (len(rest) == len(a) or not rest[len(a)].isalpha()):
                unit_raw = rest[: len(a)]
                rest = rest[len(a):].strip().lstrip(".").strip()
                break

    return (qty, unit_raw, rest, note)


def _coerce_int(value: object) -> int | None:
    """Best-effort int from recipe-scrapers fields that may be int|str|None."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_total_minutes(scraper) -> int | None:
    for attr in ("total_time", "cook_time", "prep_time"):
        getter = getattr(scraper, attr, None)
        if getter is None:
            continue
        try:
            value = getter()
        except Exception:
            continue
        coerced = _coerce_int(value)
        if coerced:
            return coerced
    return None


def _extract_yield_servings(scraper) -> int | None:
    getter = getattr(scraper, "yields", None)
    if getter is None:
        return None
    try:
        raw = getter()
    except Exception:
        return None
    if not raw:
        return None
    m = re.search(r"\d+", str(raw))
    return int(m.group(0)) if m else None


def _extract_instructions(scraper) -> list[str]:
    getter = getattr(scraper, "instructions_list", None)
    if getter is not None:
        try:
            steps = getter() or []
            if steps:
                return [str(s).strip() for s in steps if str(s).strip()]
        except Exception:
            pass
    flat = getattr(scraper, "instructions", None)
    if flat is None:
        return []
    try:
        text = flat() or ""
    except Exception:
        return []
    return [s.strip() for s in str(text).splitlines() if s.strip()]


# ── HTML fallback scraper (no JSON-LD) ─────────────────────────────────────────

_FALLBACK_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

_INGREDIENT_HEADING_RE = re.compile(r"\bingredient", re.IGNORECASE)
_INSTRUCTION_HEADING_RE = re.compile(
    r"\b(?:instruction|direction|method|preparation|step)", re.IGNORECASE,
)
_SERVING_RE = re.compile(
    r"(?:serv(?:ing|e)s?|yield|portion)s?\s*[:\-–]?\s*(\d+)", re.IGNORECASE,
)
_SERVING_REVERSE_RE = re.compile(
    r"(\d+)\s*(?:serv(?:ing|e)s?|portion)", re.IGNORECASE,
)

# ── Plain-text / caption heuristics ───────────────────────────────────────────
#
# Used by parse_recipe_from_text() for non-JSON file uploads (.txt/.md) and
# Instagram captions. The patterns intentionally skew permissive — the import
# flow surfaces a "review carefully" warning and a manual paste fallback, so
# false positives are cheaper than missed matches.

_SECTION_HEADER_RE = re.compile(
    r"^\s*#{0,6}\s*[*_]*\s*"
    r"(ingredient|instruction|direction|method|step|preparation|notes?|tips?)s?\s*"
    r"[*_:]*\s*$",
    re.IGNORECASE,
)
_INGREDIENT_SECTION_RE = re.compile(r"\bingredient", re.IGNORECASE)
_INSTRUCTION_SECTION_RE = re.compile(
    r"\b(?:instruction|direction|method|step|preparation)", re.IGNORECASE,
)
# Strip leading list markers: "1.", "1)", "- ", "* ", "• ", "Step 3:".
_LIST_MARKER_RE = re.compile(
    r"^\s*(?:Step\s*\d+\s*[:.\-)]?\s*|"
    r"\d+\s*[.)]\s+|"
    r"[\-*•·▪►▶✓✦◦]\s+)",
    re.IGNORECASE,
)
# Lines that look like ingredient rows when no section header is present.
# Allow digits, unicode fractions, or "a/an <noun>".
_INGREDIENT_LINE_HINT_RE = re.compile(
    r"^\s*(?:\d|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|(?:a|an)\s+)",
    re.IGNORECASE,
)
_INSTRUCTION_VERB_RE = re.compile(
    r"^\s*(?:add|mix|stir|heat|cook|boil|bake|fry|chop|dice|mince|pour|combine|"
    r"whisk|simmer|season|preheat|melt|brown|saute|sauté|reduce|blend|toss|"
    r"sprinkle|drizzle|serve|garnish|fold|knead|grill|roast|steam|marinate|"
    r"slice|cut|peel|grate|crush|spread|cover|remove|let|allow|place|put|"
    r"transfer|return|continue|repeat|taste|adjust|set\b|turn|reduce|bring)\b",
    re.IGNORECASE,
)
_TITLE_PREFIX_RE = re.compile(r"^(?:title|name|recipe)\s*[:\-]\s*(.+)$", re.IGNORECASE)
# instagram.com/(reel|reels|p|tv)/<shortcode>/... — query strings pass through.
_INSTAGRAM_URL_RE = re.compile(
    r"^https?://(?:www\.)?(?:instagram\.com|instagr\.am)/"
    r"(?:reel|reels|p|tv)/[A-Za-z0-9_-]+",
    re.IGNORECASE,
)

# Cap on text-parse input: 20 000 chars covers any plausible recipe page or
# caption (the longest Instagram caption is ~2 200 chars). Anything past this
# is almost certainly noise.
_TEXT_PARSE_MAX_CHARS = 20_000


def _fetch_html(url: str) -> str:
    """Download raw HTML with a browser-like User-Agent."""
    import httpx

    try:
        resp = httpx.get(url, headers={"User-Agent": _FALLBACK_UA},
                         follow_redirects=True, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        msg = str(e).lower()
        if any(s in msg for s in ("timed out", "connection", "name or service", "ssl", "dns")):
            raise ScrapeError(ScrapeErrorKind.NETWORK, str(e))
        raise ScrapeError(ScrapeErrorKind.UNKNOWN, f"HTTP fetch failed: {e}")
    return resp.text


def _list_after_heading(soup, heading_re, *, limit: int = 80) -> list[str]:
    """Find a heading matching *heading_re* and return text of subsequent list items."""
    from bs4 import Tag

    for heading in soup.find_all(re.compile(r"^h[1-6]$", re.IGNORECASE)):
        if heading_re.search(heading.get_text()):
            # Walk siblings after the heading looking for a <ul>/<ol>.
            for sib in heading.find_next_siblings():
                if not isinstance(sib, Tag):
                    continue
                if sib.name in ("ul", "ol"):
                    items = [li.get_text(separator=" ", strip=True) for li in sib.find_all("li")]
                    return [t for t in items if t][:limit]
                # If we hit another heading, stop looking.
                if re.match(r"^h[1-6]$", sib.name, re.IGNORECASE):
                    break
    return []


def _extract_ingredients_fallback(soup) -> list[str]:
    """Best-effort ingredient extraction from raw HTML."""
    # 1. schema.org microdata / RDFa attribute
    nodes = soup.select('[itemprop="recipeIngredient"]')
    if nodes:
        return [n.get_text(separator=" ", strip=True) for n in nodes if n.get_text(strip=True)]

    # 2. Class-name heuristic — containers whose class contains "ingredient"
    for el in soup.select('[class*="ingredient"]'):
        items = el.find_all("li")
        if items:
            texts = [li.get_text(separator=" ", strip=True) for li in items]
            texts = [t for t in texts if t]
            if texts:
                return texts

    # 3. Heading + following list
    return _list_after_heading(soup, _INGREDIENT_HEADING_RE)


def _extract_instructions_fallback(soup) -> list[str]:
    """Best-effort instruction extraction from raw HTML."""
    # 1. schema.org microdata / RDFa
    nodes = soup.select('[itemprop="recipeInstructions"]')
    if nodes:
        # Might be a single block or a list of steps
        steps: list[str] = []
        for n in nodes:
            lis = n.find_all("li")
            if lis:
                steps.extend(li.get_text(separator=" ", strip=True) for li in lis)
            else:
                text = n.get_text(separator="\n", strip=True)
                steps.extend(s.strip() for s in text.splitlines() if s.strip())
        if steps:
            return steps

    # 2. Class-name heuristic
    for selector in ('[class*="instruction"]', '[class*="direction"]', '[class*="step"]'):
        for el in soup.select(selector):
            items = el.find_all("li")
            if items:
                texts = [li.get_text(separator=" ", strip=True) for li in items]
                texts = [t for t in texts if t]
                if texts:
                    return texts
            # Check for <p> blocks inside
            paras = el.find_all("p")
            if paras:
                texts = [p.get_text(separator=" ", strip=True) for p in paras]
                texts = [t for t in texts if t]
                if texts:
                    return texts

    # 3. Heading + following list / paragraphs
    steps = _list_after_heading(soup, _INSTRUCTION_HEADING_RE)
    if steps:
        return steps

    # 4. Heading + following <p> blocks
    for heading in soup.find_all(re.compile(r"^h[1-6]$", re.IGNORECASE)):
        if _INSTRUCTION_HEADING_RE.search(heading.get_text()):
            from bs4 import Tag
            paras: list[str] = []
            for sib in heading.find_next_siblings():
                if not isinstance(sib, Tag):
                    continue
                if re.match(r"^h[1-6]$", sib.name, re.IGNORECASE):
                    break
                if sib.name == "p":
                    t = sib.get_text(separator=" ", strip=True)
                    if t:
                        paras.append(t)
            if paras:
                return paras

    return []


def _extract_servings_fallback(soup) -> int | None:
    """Best-effort serving count from raw HTML."""
    node = soup.select_one('[itemprop="recipeYield"]')
    if node:
        m = re.search(r"\d+", node.get_text())
        if m:
            return int(m.group(0))

    text = soup.get_text(separator=" ")
    m = _SERVING_RE.search(text)
    if m:
        return int(m.group(1))
    m = _SERVING_REVERSE_RE.search(text)
    if m:
        return int(m.group(1))
    return None


def _extract_title_fallback(soup) -> str:
    """Title from <h1> or <title>."""
    h1 = soup.find("h1")
    if h1:
        return h1.get_text(strip=True)
    title_tag = soup.find("title")
    if title_tag:
        raw = title_tag.get_text(strip=True)
        # Strip " - Site Name" / " | Site Name" suffixes
        return re.split(r"\s*[|\-–—]\s*", raw, maxsplit=1)[0].strip()
    return ""


def _extract_description_fallback(soup) -> str:
    """Description from <meta name="description">."""
    meta = soup.find("meta", attrs={"name": "description"})
    if meta and meta.get("content"):
        return meta["content"].strip()
    return ""


def _build_parsed_ingredients(
    ingredient_lines: list[str],
    known_ingredients: set[str] | None = None,
) -> list[ParsedIngredient]:
    """Run each ingredient line through the NLP / regex parser + unit canonicalization.

    Shared between :func:`_html_fallback_scrape` and
    :func:`parse_recipe_from_text` so both paths produce identical row shapes.
    Loading the known-ingredient cache is the caller's responsibility (so we
    don't refetch on every call).
    """
    from .units import parse_quantity, parse_unit, to_canonical
    from .modifiers import extract_modifier

    parsed_ings: list[ParsedIngredient] = []
    for raw_line in ingredient_lines:
        line = str(raw_line).strip()
        if not line:
            continue
        qty, unit_raw, food_raw, note = _parse_ingredient_line(line)
        if qty is None:
            qty = parse_quantity(line)
        unit_def = parse_unit(unit_raw)
        # "2 medium jalapeños" — quantity but no unit. Default to the "whole"
        # count unit so the row renders as "2 whole jalapeño" instead of bare
        # "2 jalapeño" (which then drifts when scaled).
        if qty is not None and unit_def is None:
            unit_def = parse_unit("whole")
            if unit_def is not None:
                unit_raw = unit_def.abbreviation or "whole"
        canonical_ml, canonical_g = to_canonical(qty, unit_def)
        clean_food, modifier, leftover_note = extract_modifier(food_raw, note)
        canonical_food = _normalize_ingredient_name(
            clean_food or food_raw, known_ingredients,
        )
        parsed_ings.append(ParsedIngredient(
            original_text=line,
            quantity=qty,
            unit_raw=unit_raw,
            food_raw=canonical_food or (clean_food or food_raw),
            canonical_ml=canonical_ml,
            canonical_g=canonical_g,
            note=leftover_note,
            modifier=modifier,
        ))
    return parsed_ings


def _html_fallback_scrape(url: str) -> ParsedRecipe:
    """Fetch *url* and extract recipe data from raw HTML patterns.

    Used as a fallback when ``recipe-scrapers`` finds no structured JSON-LD
    data. Looks for common HTML patterns: microdata attributes, CSS class
    names containing "ingredient"/"instruction", and section headings
    followed by lists.

    Raises :class:`ScrapeError` if no ingredients can be found even after
    the HTML heuristics — a page without any detectable ingredient list is
    unlikely to be a recipe.
    """
    from bs4 import BeautifulSoup

    html = _fetch_html(url)
    soup = BeautifulSoup(html, "html.parser")
    return _parse_html_fallback_from_soup(soup, source_url=url)


def _parse_html_fallback_from_soup(soup, *, source_url: str) -> ParsedRecipe:
    """Soup-side of HTML fallback parsing — shared between the URL-fetch path
    and the ``contentType=html`` text-import endpoint.

    Raises :class:`ScrapeError` if no ingredients are detectable.
    """
    ingredient_lines = _extract_ingredients_fallback(soup)
    instructions = _extract_instructions_fallback(soup)
    name = _extract_title_fallback(soup)

    if not ingredient_lines:
        raise ScrapeError(
            ScrapeErrorKind.NO_STRUCTURED_DATA,
            "No recipe data found on this page — try a different URL.",
        )

    known_ingredients = _load_known_ingredient_names()
    parsed_ings = _build_parsed_ingredients(ingredient_lines, known_ingredients)

    return ParsedRecipe(
        name=name or "Untitled recipe",
        description=_extract_description_fallback(soup),
        total_time_minutes=None,
        yield_servings=_extract_servings_fallback(soup),
        instructions=instructions,
        ingredients=parsed_ings,
        source_url=source_url,
        canonical_url=None,
        fallback=True,
    )


# ── Plain-text / Instagram caption parsing ────────────────────────────────────

def _strip_list_marker(line: str) -> str:
    """Remove a leading bullet/number/Step marker plus markdown decoration."""
    stripped = _LIST_MARKER_RE.sub("", line, count=1).strip()
    # Drop wrapping markdown bold/italic on the whole line: "**foo**" → "foo".
    stripped = re.sub(r"^[*_]+(.+?)[*_]+$", r"\1", stripped).strip()
    return stripped


def _extract_title_from_text(lines: list[str]) -> str:
    """Title from explicit prefix, markdown header, or first short line."""
    for line in lines[:8]:
        m = _TITLE_PREFIX_RE.match(line.strip())
        if m:
            return m.group(1).strip()[:120]
    # First markdown H1/H2 that isn't a section header.
    for line in lines[:8]:
        s = line.strip()
        if s.startswith("#"):
            cleaned = s.lstrip("#").strip()
            if cleaned and not _SECTION_HEADER_RE.match(s):
                return cleaned[:120]
    # First non-empty, non-section, non-bullet line.
    for line in lines[:8]:
        s = line.strip()
        if not s or _SECTION_HEADER_RE.match(s) or _LIST_MARKER_RE.match(s):
            continue
        return s[:120]
    return ""


def _extract_servings_from_text(text: str) -> int | None:
    """Reuse the HTML serving regexes against a plain-text blob."""
    m = _SERVING_RE.search(text)
    if m:
        try:
            return int(m.group(1))
        except (TypeError, ValueError):
            pass
    m = _SERVING_REVERSE_RE.search(text)
    if m:
        try:
            return int(m.group(1))
        except (TypeError, ValueError):
            pass
    return None


def _classify_section(header_line: str) -> str | None:
    """Return 'ingredients' / 'instructions' / None for a header line."""
    if _INGREDIENT_SECTION_RE.search(header_line):
        return "ingredients"
    if _INSTRUCTION_SECTION_RE.search(header_line):
        return "instructions"
    return None


def _split_text_sections(lines: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Walk *lines* and bucket each into (intro, ingredients, instructions).

    A section is started when a line matches ``_SECTION_HEADER_RE`` and its
    classification is ingredients-like or instructions-like. Lines outside any
    section go into ``intro`` (used for title + description inference).
    """
    intro: list[str] = []
    ings: list[str] = []
    steps: list[str] = []
    current = "intro"
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if _SECTION_HEADER_RE.match(line):
            kind = _classify_section(line)
            if kind == "ingredients":
                current = "ings"
                continue
            if kind == "instructions":
                current = "steps"
                continue
            # Other section ("Notes", "Tips") — stop adding to any recipe bucket.
            current = "other"
            continue
        cleaned = _strip_list_marker(line)
        if not cleaned:
            continue
        if current == "ings":
            ings.append(cleaned)
        elif current == "steps":
            steps.append(cleaned)
        elif current == "intro":
            intro.append(cleaned)
        # 'other' lines are dropped.
    return intro, ings, steps


def _guess_caption_buckets(lines: list[str]) -> tuple[list[str], list[str], list[str]]:
    """No section headers found — infer ingredients vs. instructions per line.

    Used for Instagram captions (and other free-form sources). Ingredient
    rows look like "2 cups flour" or "½ tsp salt"; instructions match
    imperative-verb heuristics or numbered prefixes. Title candidates are
    short non-list lines at the top.
    """
    from .units import UNIT_REGISTRY

    # Pre-compute a lowercase set of unit aliases for quick line-level checks.
    unit_aliases: set[str] = set()
    for u in UNIT_REGISTRY.values():
        for a in u.aliases:
            if a:
                unit_aliases.add(a.lower())

    intro: list[str] = []
    ings: list[str] = []
    steps: list[str] = []
    seen_recipe_line = False
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        cleaned = _strip_list_marker(line)
        if not cleaned:
            continue

        had_marker = cleaned != line.strip()
        is_step_marker = bool(re.match(r"^\s*(?:step\s*\d+|\d+\s*[.)])\s+", line, re.IGNORECASE))
        is_ing_hint = bool(_INGREDIENT_LINE_HINT_RE.match(cleaned))
        has_unit_token = any(
            re.search(rf"\b{re.escape(a)}\b", cleaned.lower())
            for a in unit_aliases
            if len(a) >= 2
        )
        is_verb = bool(_INSTRUCTION_VERB_RE.match(cleaned))

        if is_step_marker:
            steps.append(cleaned)
            seen_recipe_line = True
            continue
        if is_ing_hint and (has_unit_token or len(cleaned) < 60):
            ings.append(cleaned)
            seen_recipe_line = True
            continue
        if had_marker and is_ing_hint:
            ings.append(cleaned)
            seen_recipe_line = True
            continue
        if is_verb and len(cleaned) >= 20:
            steps.append(cleaned)
            seen_recipe_line = True
            continue

        # Pre-recipe text → intro/title bucket; mid-recipe long lines → steps.
        if not seen_recipe_line:
            intro.append(cleaned)
        elif len(cleaned) >= 30:
            steps.append(cleaned)
        # Short non-classifiable mid-text lines are dropped.

    return intro, ings, steps


def parse_recipe_from_text(text: str, source_url: str | None = None) -> ParsedRecipe:
    """Heuristic recipe extraction from a plain-text blob.

    Handles markdown / plain-text uploads and Instagram captions. Tries
    section-header splitting first; falls back to line-by-line inference for
    sources without explicit "Ingredients" / "Instructions" headers.

    Always returns ``fallback=True`` so the import UI surfaces the
    review-carefully warning. Raises :class:`ScrapeError` if no ingredients
    can be detected — the caller (or the frontend) is expected to surface a
    "paste manually" CTA in that case.
    """
    if not isinstance(text, str) or not text.strip():
        raise ScrapeError(ScrapeErrorKind.NO_STRUCTURED_DATA, "Text is empty.")

    # Normalize newlines, decode common HTML entities (captions sometimes
    # come through as "&amp;quot;..."), strip BOM, collapse blank-line runs.
    import html as html_lib

    normalized = (
        text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    )
    normalized = html_lib.unescape(normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    if len(normalized) > _TEXT_PARSE_MAX_CHARS:
        logger.info(
            "parse_recipe_from_text: truncating %d-char input to %d",
            len(normalized), _TEXT_PARSE_MAX_CHARS,
        )
        normalized = normalized[:_TEXT_PARSE_MAX_CHARS]

    lines = normalized.split("\n")

    # First pass: section-header split.
    intro, ing_lines, step_lines = _split_text_sections(lines)

    # If sections didn't catch ingredients, fall through to inference.
    if not ing_lines:
        intro, ing_lines, step_lines = _guess_caption_buckets(lines)

    if not ing_lines:
        raise ScrapeError(
            ScrapeErrorKind.NO_STRUCTURED_DATA,
            "No recipe ingredients could be detected in the text.",
        )

    title = _extract_title_from_text(intro or lines)
    # Description = first intro line that isn't the title (or a header form
    # of it). Strip leading "#" markdown so "# Spicy Pasta" matches "Spicy
    # Pasta" — otherwise the title is repeated as the description.
    description = ""
    title_lc = title.lower()
    for cand in intro:
        s = cand.strip().lstrip("#").strip()
        if s and s.lower() != title_lc:
            description = s[:240]
            break

    known_ingredients = _load_known_ingredient_names()
    parsed_ings = _build_parsed_ingredients(ing_lines, known_ingredients)

    return ParsedRecipe(
        name=title or "Untitled recipe",
        description=description,
        total_time_minutes=None,
        yield_servings=_extract_servings_from_text(normalized),
        instructions=step_lines,
        ingredients=parsed_ings,
        source_url=source_url or "",
        canonical_url=None,
        fallback=True,
    )


# ── Instagram caption extraction ───────────────────────────────────────────────

# Instagram wraps the caption in og:description / og:title using the format:
#   "1,234 likes, 56 comments - @user on January 1, 2024: \"<caption>\""
# We pull just the quoted caption when this pattern matches.
_IG_OG_WRAP_RE = re.compile(
    r"""[^"“”]*?[:\-]\s*["“](.+?)["”]\s*\.?\s*$""",
    re.DOTALL,
)


def _strip_ig_og_decoration(text: str) -> str:
    """Pull the inner caption out of an Instagram og:description wrapper."""
    if not text:
        return ""
    m = _IG_OG_WRAP_RE.match(text.strip())
    if m:
        return m.group(1).strip()
    return text.strip()


def _extract_instagram_caption(html: str) -> str | None:
    """Best-effort caption extraction from an Instagram post page.

    Looks (in order) at JSON-LD blocks, then ``og:description``,
    ``og:title``, and ``name=description`` meta tags. Returns ``None`` when
    the page is a login-wall or nothing usable is found.
    """
    from bs4 import BeautifulSoup
    import json

    soup = BeautifulSoup(html, "html.parser")

    # 1. JSON-LD blocks sometimes embed the full caption under
    # `description`, `articleBody`, or `caption`.
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = (script.string or script.get_text() or "").strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        for candidate in _iter_json_strings(data, ("caption", "articleBody", "description")):
            if candidate and len(candidate) > 20:
                return _strip_ig_og_decoration(candidate)

    # 2. OG meta — most reliable on public posts, but IG truncates to ~150 chars.
    meta = soup.find("meta", attrs={"property": "og:description"})
    if meta and meta.get("content"):
        cleaned = _strip_ig_og_decoration(meta["content"])
        if cleaned and len(cleaned) > 10:
            return cleaned

    # 3. Some IG pages put the caption in og:title.
    meta = soup.find("meta", attrs={"property": "og:title"})
    if meta and meta.get("content"):
        cleaned = _strip_ig_og_decoration(meta["content"])
        if cleaned and len(cleaned) > 20:
            return cleaned

    # 4. Standard description meta tag.
    meta = soup.find("meta", attrs={"name": "description"})
    if meta and meta.get("content"):
        cleaned = _strip_ig_og_decoration(meta["content"])
        if cleaned and len(cleaned) > 20:
            return cleaned

    return None


def _iter_json_strings(obj, keys: tuple[str, ...]):
    """Recursively yield string values found under any of *keys* inside *obj*."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k in keys:
                yield v
            else:
                yield from _iter_json_strings(v, keys)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_json_strings(item, keys)


def _scrape_instagram(url: str) -> ParsedRecipe:
    """Fetch an Instagram post and parse its caption as a recipe.

    Raises :class:`ScrapeError` (``NO_STRUCTURED_DATA``) when IG returns a
    login-wall, an empty caption, or a caption with no recognizable
    ingredients — the frontend surfaces a "paste the caption manually" CTA
    in that case.
    """
    html = _fetch_html(url)
    caption = _extract_instagram_caption(html)
    if not caption:
        logger.info("instagram fetch: no caption found in %d chars of HTML", len(html))
        raise ScrapeError(
            ScrapeErrorKind.NO_STRUCTURED_DATA,
            "Instagram blocked the auto-fetch or the post has no readable caption. "
            "Copy the caption from the Instagram app and paste it below.",
        )

    try:
        parsed = parse_recipe_from_text(caption, source_url=url)
    except ScrapeError:
        logger.info("instagram caption parse: no ingredients in %d-char caption", len(caption))
        raise ScrapeError(
            ScrapeErrorKind.NO_STRUCTURED_DATA,
            "The Instagram caption didn't contain a recognizable ingredient list. "
            "Try pasting the caption manually so you can fix it up.",
        )
    logger.info("instagram fetch: parsed %d ingredients from %s", len(parsed.ingredients), url)
    return parsed


def scrape_recipe(url: str) -> ParsedRecipe:
    """Fetch ``url`` and return a structured ``ParsedRecipe``.

    Tries schema.org JSON-LD extraction first (via ``recipe-scrapers``). If
    that fails with NO_STRUCTURED_DATA or UNSUPPORTED_SITE, falls back to
    raw HTML pattern matching. Network and invalid-URL errors are raised
    immediately — re-fetching won't help.
    """
    if not url or not isinstance(url, str):
        raise ScrapeError(ScrapeErrorKind.INVALID_URL, "URL is required.")
    if not re.match(r"^https?://", url, flags=re.IGNORECASE):
        raise ScrapeError(ScrapeErrorKind.INVALID_URL, "URL must start with http:// or https://.")

    # Instagram posts won't be in recipe-scrapers' supported list and have no
    # schema.org JSON-LD — branch straight to the caption-aware path.
    if _INSTAGRAM_URL_RE.match(url):
        return _scrape_instagram(url)

    # ── Try structured JSON-LD first via recipe-scrapers ───────────────────
    try:
        scraper = _scrape_html(url)
    except ScrapeError as e:
        if e.kind in (ScrapeErrorKind.NO_STRUCTURED_DATA, ScrapeErrorKind.UNSUPPORTED_SITE):
            logger.info("recipe-scrapers failed (%s) for %s — trying HTML fallback", e.kind, url)
            return _html_fallback_scrape(url)
        raise

    try:
        name = (scraper.title() or "").strip()
    except Exception:
        name = ""
    try:
        description = (scraper.description() or "").strip()
    except Exception:
        description = ""

    try:
        ingredient_lines = scraper.ingredients() or []
    except Exception:
        ingredient_lines = []

    if not name and not ingredient_lines:
        # Structured scraper returned nothing useful — try HTML fallback.
        logger.info("recipe-scrapers found no data for %s — trying HTML fallback", url)
        return _html_fallback_scrape(url)

    known_ingredients = _load_known_ingredient_names()
    parsed_ings = _build_parsed_ingredients(
        [str(line) for line in ingredient_lines], known_ingredients,
    )

    canonical_url: str | None = None
    canonical_getter = getattr(scraper, "canonical_url", None)
    if canonical_getter is not None:
        try:
            canonical_url = canonical_getter() or None
        except Exception:
            canonical_url = None

    return ParsedRecipe(
        name=name or "Untitled recipe",
        description=description,
        total_time_minutes=_extract_total_minutes(scraper),
        yield_servings=_extract_yield_servings(scraper),
        instructions=_extract_instructions(scraper),
        ingredients=parsed_ings,
        source_url=url,
        canonical_url=canonical_url,
    )
