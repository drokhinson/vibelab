"""Unit registry, quantity parsing, and canonical-quantity conversion.

Single source of truth for sauceboss unit handling. The canonical units are
millilitres for volume and grams for mass; every recipe ingredient is stored
with both ``quantity_canonical_ml`` and ``quantity_canonical_g`` (one of which
is null for a given unit, since v1 has no density data).

Conversion across the volume/mass boundary is a TODO — it requires a per-food
density map. See :data:`DENSITY_TODO` below.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from fractions import Fraction


class UnitDimension(StrEnum):
    VOLUME = "volume"
    MASS = "mass"
    COUNT = "count"


@dataclass(frozen=True)
class UnitDef:
    id: str
    name: str
    plural: str
    abbreviation: str
    plural_abbreviation: str
    dimension: UnitDimension
    ml_per_unit: float | None
    g_per_unit: float | None
    aliases: tuple[str, ...]


# ── Registry ──────────────────────────────────────────────────────────────────
# Conversion factors are exact (US customary). Mealie's recipe-scrapers also
# emits these unit names directly when scraping schema.org JSON-LD.

UNIT_REGISTRY: dict[str, UnitDef] = {
    "teaspoon": UnitDef(
        id="teaspoon", name="teaspoon", plural="teaspoons",
        abbreviation="tsp", plural_abbreviation="tsp",
        dimension=UnitDimension.VOLUME, ml_per_unit=4.92892, g_per_unit=None,
        aliases=("tsp", "tsps", "teaspoon", "teaspoons", "t"),
    ),
    "tablespoon": UnitDef(
        id="tablespoon", name="tablespoon", plural="tablespoons",
        abbreviation="tbsp", plural_abbreviation="tbsp",
        dimension=UnitDimension.VOLUME, ml_per_unit=14.7868, g_per_unit=None,
        aliases=("tbsp", "tbsps", "tablespoon", "tablespoons", "tbs", "tbl", "T"),
    ),
    "cup": UnitDef(
        id="cup", name="cup", plural="cups",
        abbreviation="cup", plural_abbreviation="cups",
        dimension=UnitDimension.VOLUME, ml_per_unit=236.588, g_per_unit=None,
        aliases=("cup", "cups", "c"),
    ),
    "fluid_ounce": UnitDef(
        id="fluid_ounce", name="fluid ounce", plural="fluid ounces",
        abbreviation="fl oz", plural_abbreviation="fl oz",
        dimension=UnitDimension.VOLUME, ml_per_unit=29.5735, g_per_unit=None,
        aliases=("fl oz", "fl. oz.", "fluid ounce", "fluid ounces", "floz"),
    ),
    "millilitre": UnitDef(
        id="millilitre", name="millilitre", plural="millilitres",
        abbreviation="ml", plural_abbreviation="ml",
        dimension=UnitDimension.VOLUME, ml_per_unit=1.0, g_per_unit=None,
        aliases=("ml", "milliliter", "milliliters", "millilitre", "millilitres"),
    ),
    "litre": UnitDef(
        id="litre", name="litre", plural="litres",
        abbreviation="l", plural_abbreviation="l",
        dimension=UnitDimension.VOLUME, ml_per_unit=1000.0, g_per_unit=None,
        aliases=("l", "liter", "liters", "litre", "litres"),
    ),
    "gram": UnitDef(
        id="gram", name="gram", plural="grams",
        abbreviation="g", plural_abbreviation="g",
        dimension=UnitDimension.MASS, ml_per_unit=None, g_per_unit=1.0,
        aliases=("g", "gram", "grams", "gr"),
    ),
    "kilogram": UnitDef(
        id="kilogram", name="kilogram", plural="kilograms",
        abbreviation="kg", plural_abbreviation="kg",
        dimension=UnitDimension.MASS, ml_per_unit=None, g_per_unit=1000.0,
        aliases=("kg", "kilogram", "kilograms"),
    ),
    "ounce": UnitDef(
        id="ounce", name="ounce", plural="ounces",
        abbreviation="oz", plural_abbreviation="oz",
        dimension=UnitDimension.MASS, ml_per_unit=None, g_per_unit=28.3495,
        aliases=("oz", "ounce", "ounces"),
    ),
    "pound": UnitDef(
        id="pound", name="pound", plural="pounds",
        abbreviation="lb", plural_abbreviation="lbs",
        dimension=UnitDimension.MASS, ml_per_unit=None, g_per_unit=453.592,
        aliases=("lb", "lbs", "pound", "pounds"),
    ),
    "piece": UnitDef(
        id="piece", name="piece", plural="pieces",
        abbreviation="piece", plural_abbreviation="pieces",
        dimension=UnitDimension.COUNT, ml_per_unit=None, g_per_unit=None,
        aliases=("piece", "pieces", "pc", "pcs"),
    ),
    "clove": UnitDef(
        id="clove", name="clove", plural="cloves",
        abbreviation="clove", plural_abbreviation="cloves",
        dimension=UnitDimension.COUNT, ml_per_unit=None, g_per_unit=None,
        aliases=("clove", "cloves"),
    ),
    "pinch": UnitDef(
        id="pinch", name="pinch", plural="pinches",
        abbreviation="pinch", plural_abbreviation="pinches",
        dimension=UnitDimension.COUNT, ml_per_unit=None, g_per_unit=None,
        aliases=("pinch", "pinches"),
    ),
    "dash": UnitDef(
        id="dash", name="dash", plural="dashes",
        abbreviation="dash", plural_abbreviation="dashes",
        dimension=UnitDimension.COUNT, ml_per_unit=None, g_per_unit=None,
        aliases=("dash", "dashes"),
    ),
    "to_taste": UnitDef(
        id="to_taste", name="to taste", plural="to taste",
        abbreviation="to taste", plural_abbreviation="to taste",
        dimension=UnitDimension.COUNT, ml_per_unit=None, g_per_unit=None,
        aliases=("to taste",),
    ),
}


# Reverse alias index, lowercased and stripped, for fast lookup.
_ALIAS_INDEX: dict[str, UnitDef] = {}
for _u in UNIT_REGISTRY.values():
    for _alias in _u.aliases:
        _ALIAS_INDEX[_alias.lower().strip()] = _u


# TODO(density): when a curated density map lands, allow ml→g and g→ml when
# food_id matches a known density. Today we leave the cross-dimensional
# canonical field as None.
DENSITY_TODO = (
    "Volume↔mass conversion is unsupported in v1 — fill out a curated "
    "{food_id: density_g_per_ml} map and extend to_canonical()."
)


# ── Quantity parsing ──────────────────────────────────────────────────────────

# Maps unicode vulgar fractions to their (numerator, denominator) pair.
_VULGAR_FRACTIONS = {
    "½": (1, 2), "⅓": (1, 3), "⅔": (2, 3),
    "¼": (1, 4), "¾": (3, 4),
    "⅕": (1, 5), "⅖": (2, 5), "⅗": (3, 5), "⅘": (4, 5),
    "⅙": (1, 6), "⅚": (5, 6),
    "⅛": (1, 8), "⅜": (3, 8), "⅝": (5, 8), "⅞": (7, 8),
}

_RANGE_RE = re.compile(r"^\s*(\S+)\s*[-–~]\s*(\S+)\s*$")


def parse_quantity(raw: str | None) -> float | None:
    """Parse a recipe quantity string into a float.

    Handles "1.5", "1 1/2", "½", "1½", "1-2" (returns the low end), and
    decimal commas. Returns None for unparseable input.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None

    # Replace vulgar fractions BEFORE NFKC, with a leading space so e.g. "1½"
    # decomposes to "1 1/2" rather than "11⁄2" (NFKC of ½ is U+2044 fraction
    # slash, which Fraction doesn't recognise and would produce 11/2=5.5).
    for sym, (num, den) in _VULGAR_FRACTIONS.items():
        text = text.replace(sym, f" {num}/{den}")

    # Now NFKC for any remaining oddities (smart quotes, full-width digits)
    # and map U+2044 to ASCII '/' as a belt-and-suspenders.
    text = unicodedata.normalize("NFKC", text).replace("⁄", "/").strip()

    # Range "1-2" / "1–2" / "1 to 2" → low end, document.
    text = re.sub(r"\bto\b", "-", text, flags=re.IGNORECASE)
    m = _RANGE_RE.match(text)
    if m:
        text = m.group(1)

    # Decimal comma (European style)
    text = text.replace(",", ".")
    text = text.strip()

    parts = text.split()
    if not parts:
        return None

    total = 0.0
    try:
        for part in parts:
            if "/" in part:
                total += float(Fraction(part))
            else:
                total += float(part)
    except (ValueError, ZeroDivisionError):
        return None
    return total


# ── Unit parsing ──────────────────────────────────────────────────────────────

def parse_unit(raw: str | None) -> UnitDef | None:
    """Look up a unit definition by name, plural, abbreviation, or alias.

    Case-insensitive. Returns None for unrecognised input (caller should keep
    the raw string in ``original_text`` and leave ``unit_id`` null).
    """
    if not raw:
        return None
    key = raw.lower().strip().rstrip(".")
    return _ALIAS_INDEX.get(key)


# ── Canonical conversion ──────────────────────────────────────────────────────

def to_canonical(qty: float | None, unit: UnitDef | None) -> tuple[float | None, float | None]:
    """Convert (qty, unit) to (canonical_ml, canonical_g).

    Returns (None, None) when conversion isn't possible (count units, missing
    quantity, unknown unit). A value is set only for the unit's own dimension;
    the other side is None until a density map is added (see DENSITY_TODO).
    """
    if qty is None or unit is None:
        return (None, None)
    if unit.dimension is UnitDimension.VOLUME and unit.ml_per_unit is not None:
        return (qty * unit.ml_per_unit, None)
    if unit.dimension is UnitDimension.MASS and unit.g_per_unit is not None:
        return (None, qty * unit.g_per_unit)
    return (None, None)


def from_canonical(
    canonical_ml: float | None,
    canonical_g: float | None,
    target: UnitDef,
) -> float | None:
    """Convert a canonical quantity back to ``target`` unit.

    Returns None when no canonical value matches the target's dimension (e.g.
    target is a mass unit but only canonical_ml is set, since we don't have
    density). Caller should fall back to the original quantity in that case.
    """
    if target.dimension is UnitDimension.VOLUME:
        if canonical_ml is None or target.ml_per_unit in (None, 0):
            return None
        return canonical_ml / target.ml_per_unit
    if target.dimension is UnitDimension.MASS:
        if canonical_g is None or target.g_per_unit in (None, 0):
            return None
        return canonical_g / target.g_per_unit
    return None
