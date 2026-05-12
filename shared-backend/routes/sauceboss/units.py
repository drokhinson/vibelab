"""Unit registry, quantity parsing, and canonical-quantity conversion.

The ``sauceboss_unit`` DB table is the single source of truth. On startup the
backend loads the table into an in-memory cache (``UNIT_REGISTRY``) so that
unit parsing, alias resolution, and canonical mL/g conversion run without
hitting the database on every request.

Call :func:`load_unit_registry` once at app startup (FastAPI lifespan). All
public accessors (:data:`UNIT_REGISTRY`, :func:`parse_unit`, etc.) read from
the cached dict.

Conversion across the volume/mass boundary is a TODO — it requires a per-food
density map. See :data:`DENSITY_TODO` below.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from fractions import Fraction

log = logging.getLogger(__name__)


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
    quantifiable: bool = True


# ── Registry (populated at startup by load_unit_registry) ─────────────────────

UNIT_REGISTRY: dict[str, UnitDef] = {}

# Reverse alias index, lowercased and stripped, for fast lookup.
_ALIAS_INDEX: dict[str, UnitDef] = {}


def _rebuild_alias_index() -> None:
    """Rebuild ``_ALIAS_INDEX`` from the current ``UNIT_REGISTRY``."""
    _ALIAS_INDEX.clear()
    for u in UNIT_REGISTRY.values():
        for alias in u.aliases:
            _ALIAS_INDEX[alias.lower().strip()] = u


def load_unit_registry() -> None:
    """Load units from the ``sauceboss_unit`` DB table into the in-memory cache.

    Intended to be called once at FastAPI startup. Safe to call again to
    refresh (e.g. after a migration adds a new unit row).
    """
    from db import get_supabase

    sb = get_supabase()
    resp = sb.table("sauceboss_unit").select("*").execute()
    rows = resp.data

    UNIT_REGISTRY.clear()
    for row in rows:
        aliases_raw = row.get("aliases") or []
        u = UnitDef(
            id=row["id"],
            name=row["name"],
            plural=row["plural"],
            abbreviation=row["abbreviation"],
            plural_abbreviation=row["plural_abbreviation"],
            dimension=UnitDimension(row["dimension"]),
            ml_per_unit=row.get("ml_per_unit"),
            g_per_unit=row.get("g_per_unit"),
            aliases=tuple(aliases_raw),
            quantifiable=row.get("quantifiable", True),
        )
        UNIT_REGISTRY[u.id] = u

    _rebuild_alias_index()
    log.info("Loaded %d units from sauceboss_unit", len(UNIT_REGISTRY))


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
