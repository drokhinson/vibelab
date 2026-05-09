"""External plant-API clients (Trefle primary, Perenual fallback for hardiness).

The cache route uses these to populate `plantplanner_plant_cache` on miss.
All user-facing reads go through the cache table directly — these clients are
only invoked during cache-fill / cache-enrich.

Normalization target shape matches `analysis/api-notes.md` (the columns of
`plantplanner_plant_cache`). All fields are nullable and merged from whichever
source provided them; precedence is Perenual for hardiness/sunlight/watering,
Trefle for height/pH/days_to_harvest.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

TREFLE_BASE = "https://trefle.io/api/v1"
PERENUAL_BASE = "https://perenual.com/api/v2"

# Cap external network spend per user query.
SEARCH_RESULT_CAP = 24
HTTP_TIMEOUT = 8.0


def _trefle_token() -> Optional[str]:
    return os.environ.get("TREFLE_API_TOKEN") or None


def _perenual_key() -> Optional[str]:
    return os.environ.get("PERENUAL_API_KEY") or None


# ── Trefle ──────────────────────────────────────────────────────────────────

async def trefle_search(query: str, page: int = 1) -> List[Dict[str, Any]]:
    """Search Trefle by free-text query. Returns raw API records (capped)."""
    token = _trefle_token()
    if not token:
        logger.warning("TREFLE_API_TOKEN not set — skipping Trefle search")
        return []
    url = f"{TREFLE_BASE}/plants/search"
    params = {"q": query, "token": token, "page": page}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params=params)
        if resp.status_code != 200:
            logger.warning("Trefle search failed: %s %s", resp.status_code, resp.text[:200])
            return []
        data = resp.json().get("data") or []
        return data[:SEARCH_RESULT_CAP]


async def trefle_filter(
    *,
    edible: Optional[bool] = None,
    vegetable: Optional[bool] = None,
    light_min: Optional[int] = None,
    page: int = 1,
) -> List[Dict[str, Any]]:
    """Filtered Trefle list — used for the wizard's structured criteria query."""
    token = _trefle_token()
    if not token:
        return []
    url = f"{TREFLE_BASE}/plants"
    params: Dict[str, Any] = {"token": token, "page": page}
    if edible is not None:
        params["filter[edible]"] = "true" if edible else "false"
    if vegetable is not None:
        params["filter[vegetable]"] = "true" if vegetable else "false"
    if light_min is not None:
        params["filter[light]"] = str(light_min)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params=params)
        if resp.status_code != 200:
            logger.warning("Trefle filter failed: %s %s", resp.status_code, resp.text[:200])
            return []
        data = resp.json().get("data") or []
        return data[:SEARCH_RESULT_CAP]


async def trefle_get(plant_id: int) -> Optional[Dict[str, Any]]:
    """Fetch full Trefle record (includes growth + specifications nested fields)."""
    token = _trefle_token()
    if not token:
        return None
    url = f"{TREFLE_BASE}/plants/{plant_id}"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params={"token": token})
        if resp.status_code != 200:
            return None
        return resp.json().get("data")


# ── Perenual ────────────────────────────────────────────────────────────────

async def perenual_search(query: str) -> List[Dict[str, Any]]:
    key = _perenual_key()
    if not key:
        logger.info("PERENUAL_API_KEY not set — Perenual unavailable")
        return []
    url = f"{PERENUAL_BASE}/species-list"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params={"key": key, "q": query})
        if resp.status_code != 200:
            return []
        data = resp.json().get("data") or []
        return data[:SEARCH_RESULT_CAP]


async def perenual_get(plant_id: int) -> Optional[Dict[str, Any]]:
    key = _perenual_key()
    if not key:
        return None
    url = f"{PERENUAL_BASE}/species/details/{plant_id}"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, params={"key": key})
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


def _normalize_trefle_light(light: Any) -> Optional[str]:
    """Trefle light is 0–10. ≥7 = full_sun, 4–6 = part_shade, 0–3 = full_shade."""
    if light is None:
        return None
    try:
        n = int(light)
    except (TypeError, ValueError):
        return None
    if n >= 7:
        return "full_sun"
    if n >= 4:
        return "part_shade"
    return "full_shade"


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


def normalize_trefle(record: Dict[str, Any], detail: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Map a Trefle search/list/detail record onto the cache-row shape."""
    detail = detail or record
    growth = detail.get("growth") or {}
    specs = detail.get("specifications") or {}

    return {
        "source": "trefle",
        "source_id": str(record.get("id") or detail.get("id") or ""),
        "scientific_name": record.get("scientific_name") or detail.get("scientific_name") or "",
        "common_name": record.get("common_name") or detail.get("common_name"),
        "family": record.get("family") or detail.get("family"),
        "sunlight": _normalize_trefle_light(growth.get("light")),
        "height_min_cm": _to_int(((specs.get("average_height") or {}).get("cm"))),
        "height_max_cm": _to_int(((specs.get("maximum_height") or {}).get("cm"))),
        "days_to_harvest": _to_int(growth.get("days_to_harvest")),
        "edible": detail.get("edible"),
        "vegetable": detail.get("vegetable"),
        "toxicity": specs.get("toxicity"),
        "growth_rate": specs.get("growth_rate"),
        "ph_min": _to_float(growth.get("ph_minimum")),
        "ph_max": _to_float(growth.get("ph_maximum")),
        "sowing": growth.get("sowing"),
        "nitrogen_fixation": specs.get("nitrogen_fixation"),
        "image_regular_url": record.get("image_url") or detail.get("image_url"),
        "raw_trefle_json": detail,
    }


def normalize_perenual(record: Dict[str, Any]) -> Dict[str, Any]:
    """Map a Perenual record onto the cache-row shape (fills hardiness + indoor)."""
    sci = record.get("scientific_name") or []
    scientific_name = sci[0] if isinstance(sci, list) and sci else (sci if isinstance(sci, str) else "")
    image = record.get("default_image") or {}
    hardiness = record.get("hardiness") or {}

    cycle_raw = (record.get("cycle") or "").lower()
    cycle = cycle_raw if cycle_raw in ("annual", "perennial", "biennial") else None

    watering_raw = (record.get("watering") or "").lower()
    watering = watering_raw if watering_raw in ("frequent", "average", "minimum", "none") else None

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
        "image_thumbnail_url": image.get("thumbnail"),
        "image_medium_url": image.get("medium_url"),
        "image_regular_url": image.get("regular_url") or image.get("original_url"),
        "raw_perenual_json": record,
    }


def merge_records(*records: Dict[str, Any]) -> Dict[str, Any]:
    """Merge normalized records, later args overriding earlier where a value is non-null.

    Used to combine a Trefle base with a Perenual hardiness/image overlay.
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
