"""External plant-API client — Perenual is the sole upstream source.

The cache route uses these to populate `plantplanner_plant_cache` on miss
or wizard fill. All user-facing reads go through the cache table directly;
these clients are only invoked during cache-fill / cache-enrich.

Trefle and Flora support was removed in May 2026. The cache columns those
sources used (raw_trefle_json, height_*_cm, ph_*, days_to_harvest, sowing,
growth_rate, toxicity, nitrogen_fixation) are still read by the popup and
now backfilled from Perenual species-details where the API provides them
(dimensions → height/spread, growth_rate direct, poisonous_to_humans/pets
→ toxicity).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from api_logger import log_external_call

logger = logging.getLogger(__name__)

PERENUAL_BASE = "https://perenual.com/api/v2"

# Cap external network spend per user query.
SEARCH_RESULT_CAP = 24
HTTP_TIMEOUT = 8.0


def _perenual_key() -> Optional[str]:
    return os.environ.get("PERENUAL_API_KEY") or None


# ── Perenual ────────────────────────────────────────────────────────────────

async def perenual_search(query: str) -> List[Dict[str, Any]]:
    key = _perenual_key()
    if not key:
        logger.info("PERENUAL_API_KEY not set — Perenual unavailable")
        return []
    url = f"{PERENUAL_BASE}/species-list"
    params = {"key": key, "q": query}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        async with log_external_call(
            app="plant-planner", api_name="perenual",
            method="GET", url=url, params=params, redact_params=("key",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
        if resp.status_code != 200:
            return []
        data = resp.json().get("data") or []
        return data[:SEARCH_RESULT_CAP]


# Forward map: internal sunlight enum → Perenual filter param value.
# Wizard values now align with Perenual 1:1 — this map is identity-only and
# kept as a safety filter against unknown values reaching the API call.
_PERENUAL_SUNLIGHT_FILTER = {
    "full_sun":       "full_sun",
    "sun-part_shade": "sun-part_shade",
    "part_shade":     "part_shade",
    "full_shade":     "full_shade",
}


async def perenual_filter(
    *,
    watering: Optional[str] = None,
    sunlight: Optional[str] = None,
    indoor: Optional[bool] = None,
    edible: Optional[bool] = None,
    poisonous: Optional[bool] = None,
    query: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Filtered Perenual species-list — primary seed for the cache fill.

    Mirrors the wizard filters onto Perenual's v2/species-list query params.
    The endpoint accepts watering/sunlight/indoor/edible/poisonous as direct
    filters. Hardiness is intentionally NOT sent: Perenual's `hardiness=N-N`
    param matches plants whose range *exactly* matches that span — combined
    with sparse data it returns near-empty result sets. The local cache
    query handles zone matching against the response's hardiness_min/max
    fields instead. `indoor=0` is also skipped: Perenual's indoor flag is
    sparsely populated, so filtering to non-indoor excludes most rows; we
    only send `indoor=1` when the planter is climate-controlled. Cycle is
    informational on the cache row, not a filter. Pagination is omitted;
    revisit if responses outgrow the SEARCH_RESULT_CAP slice.
    """
    key = _perenual_key()
    if not key:
        logger.info("PERENUAL_API_KEY not set — Perenual filter unavailable")
        return []
    url = f"{PERENUAL_BASE}/species-list"
    params: Dict[str, Any] = {"key": key}
    if watering:
        params["watering"] = watering
    if sunlight:
        mapped = _PERENUAL_SUNLIGHT_FILTER.get(sunlight)
        if mapped:
            params["sunlight"] = mapped
    if indoor is True:
        params["indoor"] = 1
    if edible is not None:
        params["edible"] = 1 if edible else 0
    if poisonous is not None:
        params["poisonous"] = 1 if poisonous else 0
    if query:
        params["q"] = query
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        async with log_external_call(
            app="plant-planner", api_name="perenual",
            method="GET", url=url, params=params, redact_params=("key",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
        if resp.status_code != 200:
            logger.warning("Perenual filter failed: %s %s", resp.status_code, resp.text[:200])
            return []
        data = resp.json().get("data") or []
        return data[:SEARCH_RESULT_CAP]


async def perenual_get(plant_id: int) -> Optional[Dict[str, Any]]:
    """Fetch the rich species-details payload for a single Perenual id.

    The species-list /filter endpoint returns a slim summary; this call
    populates the fields the popup actually needs (description, care_level,
    soil[], growing_months[], attracts[], dimensions, hardiness, …).
    """
    key = _perenual_key()
    if not key:
        return None
    url = f"{PERENUAL_BASE}/species/details/{plant_id}"
    params = {"key": key}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        async with log_external_call(
            app="plant-planner", api_name="perenual",
            method="GET", url=url, params=params, redact_params=("key",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
        if resp.status_code != 200:
            return None
        return resp.json()


async def perenual_lookup_by_scientific(scientific_name: str) -> Optional[Dict[str, Any]]:
    """Find a Perenual record by scientific name. Returns the first match or None."""
    candidates = await perenual_search(scientific_name)
    target = scientific_name.strip().lower()
    for c in candidates:
        sci = c.get("scientific_name") or []
        if isinstance(sci, list) and sci and sci[0].strip().lower() == target:
            return c
    return candidates[0] if candidates else None


# ── Normalization to plantplanner_plant_cache row shape ─────────────────────

_SUNLIGHT_MAP_PERENUAL = {
    "full_sun": "full_sun",
    "full sun": "full_sun",
    "sun-part_shade": "sun-part_shade",
    "sun-part shade": "sun-part_shade",
    "sun/part shade": "sun-part_shade",
    "part_shade": "part_shade",
    "part shade": "part_shade",
    "part sun/part shade": "part_shade",
    "part sun": "part_shade",
    "filtered shade": "part_shade",
    "full_shade": "full_shade",
    "full shade": "full_shade",
    "deep shade": "full_shade",
}


def _normalize_perenual_sunlight(values: Any) -> Optional[str]:
    if not values:
        return None
    if isinstance(values, list):
        for v in values:
            mapped = _SUNLIGHT_MAP_PERENUAL.get(str(v).strip().lower())
            if mapped:
                return mapped
    elif isinstance(values, str):
        return _SUNLIGHT_MAP_PERENUAL.get(values.strip().lower())
    return None


def _to_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _cm_from_dimension(dim: Dict[str, Any], value_key: str) -> Optional[int]:
    """Extract a single value from a Perenual `dimensions` object, in cm.

    Perenual ships `{type, min_value, max_value, unit}` per axis. Common
    units are 'cm', 'inches', 'feet', 'meters'. Convert to cm for the
    cache columns.
    """
    raw = _to_float(dim.get(value_key))
    if raw is None:
        return None
    unit = (dim.get("unit") or "").strip().lower()
    if unit in ("cm", "centimeters", "centimeter"):
        return int(round(raw))
    if unit in ("m", "meter", "meters"):
        return int(round(raw * 100))
    if unit in ("inches", "inch", "in"):
        return int(round(raw * 2.54))
    if unit in ("feet", "foot", "ft"):
        return int(round(raw * 30.48))
    # Unknown unit: best-effort assume cm so we don't drop the value entirely.
    return int(round(raw))


def _height_spread_from_dimensions(dimensions: Any) -> Dict[str, Optional[int]]:
    """Pull height_min/max and spread from a Perenual `dimensions` payload.

    `dimensions` may be a single object or a list of objects. We pick the
    first dimension whose `type` matches each axis (Height vs Width/Spread).
    """
    if not dimensions:
        return {"height_min_cm": None, "height_max_cm": None, "spread_cm": None}
    items = dimensions if isinstance(dimensions, list) else [dimensions]
    height_min = height_max = spread = None
    for item in items:
        if not isinstance(item, dict):
            continue
        type_str = (item.get("type") or "").strip().lower()
        if "height" in type_str and height_max is None:
            height_min = _cm_from_dimension(item, "min_value")
            height_max = _cm_from_dimension(item, "max_value")
        elif ("width" in type_str or "spread" in type_str) and spread is None:
            spread = _cm_from_dimension(item, "max_value") or _cm_from_dimension(item, "min_value")
    return {"height_min_cm": height_min, "height_max_cm": height_max, "spread_cm": spread}


def _toxicity_from_perenual(record: Dict[str, Any]) -> Optional[str]:
    """Derive a short human/pet toxicity label from Perenual booleans."""
    parts: List[str] = []
    if _to_int(record.get("poisonous_to_humans")):
        parts.append("humans")
    if _to_int(record.get("poisonous_to_pets")):
        parts.append("pets")
    if not parts:
        return None
    return "toxic to " + ", ".join(parts)


def _edible_from_perenual(record: Dict[str, Any]) -> Optional[bool]:
    fruit = record.get("edible_fruit")
    leaf = record.get("edible_leaf")
    if fruit is None and leaf is None:
        return None
    return bool(fruit) or bool(leaf)


def _vegetable_from_perenual(record: Dict[str, Any]) -> Optional[bool]:
    type_str = (record.get("type") or "").strip().lower()
    if not type_str:
        return None
    return type_str == "vegetable"


def normalize_perenual(record: Dict[str, Any]) -> Dict[str, Any]:
    """Map a Perenual record (list summary or detail payload) onto the cache row.

    Detail-only fields (dimensions → height/spread, growth_rate, edible_*,
    poisonous_to_*, family, hardiness, indoor) populate when the upstream
    species-details call has been made; they're left null for plain
    species-list rows. The full payload always rides along in
    `raw_perenual_json` so the popup can read description / care_level /
    soil / growing_months / attracts / etc. without further normalization.
    """
    sci = record.get("scientific_name") or []
    scientific_name = sci[0] if isinstance(sci, list) and sci else (sci if isinstance(sci, str) else "")
    image = record.get("default_image") or {}
    hardiness = record.get("hardiness") or {}

    cycle_raw = (record.get("cycle") or "").lower()
    cycle = cycle_raw if cycle_raw in ("annual", "perennial", "biennial") else None

    watering_raw = (record.get("watering") or "").lower()
    watering = watering_raw if watering_raw in ("frequent", "average", "minimum", "none") else None

    growth_rate_raw = (record.get("growth_rate") or "").strip().lower() or None

    dimensions = _height_spread_from_dimensions(record.get("dimensions"))

    return {
        "source": "perenual",
        "source_id": str(record.get("id") or ""),
        "scientific_name": scientific_name,
        "common_name": record.get("common_name"),
        "family": record.get("family"),
        "hardiness_min": _to_int(hardiness.get("min")),
        "hardiness_max": _to_int(hardiness.get("max")),
        "sunlight": _normalize_perenual_sunlight(record.get("sunlight")),
        "watering": watering,
        "cycle": cycle,
        "indoor": record.get("indoor"),
        "height_min_cm": dimensions["height_min_cm"],
        "height_max_cm": dimensions["height_max_cm"],
        "spread_cm": dimensions["spread_cm"],
        "growth_rate": growth_rate_raw,
        "edible": _edible_from_perenual(record),
        "vegetable": _vegetable_from_perenual(record),
        "toxicity": _toxicity_from_perenual(record),
        "image_thumbnail_url": image.get("thumbnail"),
        "image_medium_url": image.get("medium_url"),
        "image_regular_url": image.get("regular_url") or image.get("original_url"),
        "raw_perenual_json": record,
    }


def merge_records(*records: Dict[str, Any]) -> Dict[str, Any]:
    """Merge normalized records, later args overriding earlier where a value is non-null.

    Used today by `catalog_detail`'s opportunistic Perenual hardiness backfill
    on a row that previously imported with hardiness null.
    """
    out: Dict[str, Any] = {}
    for rec in records:
        for key, value in rec.items():
            if value is None or value == "" or value == []:
                continue
            out[key] = value
    if "source" not in out:
        out["source"] = "merged"
    elif sum(1 for r in records if r.get("source")) > 1:
        out["source"] = "merged"
    return out
