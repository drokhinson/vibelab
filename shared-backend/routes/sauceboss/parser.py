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

    ingredient_lines = _extract_ingredients_fallback(soup)
    instructions = _extract_instructions_fallback(soup)
    name = _extract_title_fallback(soup)

    if not ingredient_lines:
        raise ScrapeError(
            ScrapeErrorKind.NO_STRUCTURED_DATA,
            "No recipe data found on this page — try a different URL.",
        )

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
        canonical_ml, canonical_g = to_canonical(qty, unit_def)
        clean_food, modifier, leftover_note = extract_modifier(food_raw, note)
        parsed_ings.append(ParsedIngredient(
            original_text=line,
            quantity=qty,
            unit_raw=unit_raw,
            food_raw=clean_food or food_raw,
            canonical_ml=canonical_ml,
            canonical_g=canonical_g,
            note=leftover_note,
            modifier=modifier,
        ))

    return ParsedRecipe(
        name=name or "Untitled recipe",
        description=_extract_description_fallback(soup),
        total_time_minutes=None,
        yield_servings=_extract_servings_fallback(soup),
        instructions=instructions,
        ingredients=parsed_ings,
        source_url=url,
        canonical_url=None,
        fallback=True,
    )


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
        canonical_ml, canonical_g = to_canonical(qty, unit_def)
        clean_food, modifier, leftover_note = extract_modifier(food_raw, note)
        parsed_ings.append(ParsedIngredient(
            original_text=line,
            quantity=qty,
            unit_raw=unit_raw,
            food_raw=clean_food or food_raw,
            canonical_ml=canonical_ml,
            canonical_g=canonical_g,
            note=leftover_note,
            modifier=modifier,
        ))

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
