"""External plant-API clients (Perenual primary seed, Trefle/Flora enrichers).

The cache route uses these to populate `plantplanner_plant_cache` on miss.
All user-facing reads go through the cache table directly — these clients are
only invoked during cache-fill / cache-enrich.

Normalization target shape matches `analysis/api-notes.md` (the columns of
`plantplanner_plant_cache`). All fields are nullable and merged from whichever
source provided them; precedence is Perenual for hardiness/sunlight/watering/
cycle/indoor/images, Trefle for height/pH/days_to_harvest, Flora for
US-flora-specific supplements.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from api_logger import log_external_call

logger = logging.getLogger(__name__)

TREFLE_BASE = "https://trefle.io/api/v1"
PERENUAL_BASE = "https://perenual.com/api/v2"
FLORA_BASE = "https://floraapi.com/api"

# Cap external network spend per user query.
SEARCH_RESULT_CAP = 24
HTTP_TIMEOUT = 8.0


def _trefle_token() -> Optional[str]:
    return os.environ.get("TREFLE_API_TOKEN") or None


def _perenual_key() -> Optional[str]:
    return os.environ.get("PERENUAL_API_KEY") or None


def _flora_key() -> Optional[str]:
    return os.environ.get("FLORA_API_KEY") or None


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
        async with log_external_call(
            app="plant-planner", api_name="trefle",
            method="GET", url=url, params=params, redact_params=("token",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
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
        async with log_external_call(
            app="plant-planner", api_name="trefle",
            method="GET", url=url, params=params, redact_params=("token",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
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
    params = {"token": token}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        async with log_external_call(
            app="plant-planner", api_name="trefle",
            method="GET", url=url, params=params, redact_params=("token",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
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
    hardiness: Optional[int] = None,
    indoor: Optional[bool] = None,
    edible: Optional[bool] = None,
    poisonous: Optional[bool] = None,
    query: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Filtered Perenual species-list — primary seed for the cache fill.

    Mirrors the wizard filters onto Perenual's v2/species-list query params.
    The endpoint accepts watering/sunlight/indoor/edible/poisonous as direct
    filters and `hardiness` as a "min-max" zone-range string. `cycle` is
    deliberately not surfaced — it's informational on the cache row, not a
    filter. Pagination is also omitted; revisit if responses outgrow the
    SEARCH_RESULT_CAP slice.
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
    if hardiness is not None:
        params["hardiness"] = f"{hardiness}-{hardiness}"
    if indoor is not None:
        params["indoor"] = 1 if indoor else 0
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


# ── Flora (paid; US-flora-focused) ──────────────────────────────────────────
#
# Flora's response shape isn't fully documented publicly; the field names
# below follow the analysis/api-notes.md notes ("verify against live docs").
# Keep the normalizer defensive — null any field that doesn't appear.


class FloraConfigError(RuntimeError):
    """Raised when FLORA_API_KEY is required but not configured."""


def _require_flora_key() -> str:
    key = _flora_key()
    if not key:
        raise FloraConfigError("FLORA_API_KEY is not configured")
    return key


async def flora_search(query: str) -> List[Dict[str, Any]]:
    """Search Flora by free-text query. Raises FloraConfigError if no key set."""
    key = _require_flora_key()
    url = f"{FLORA_BASE}/plants"
    params = {"search": query, "api_key": key, "limit": SEARCH_RESULT_CAP}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        async with log_external_call(
            app="plant-planner", api_name="flora",
            method="GET", url=url, params=params, redact_params=("api_key",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)
        if resp.status_code != 200:
            logger.warning("Flora search failed: %s %s", resp.status_code, resp.text[:200])
            return []
        body = resp.json()
        # Flora has been observed to return either {"data":[...]} or a bare list.
        data = body.get("data") if isinstance(body, dict) else body
        if not isinstance(data, list):
            return []
        return data[:SEARCH_RESULT_CAP]


async def flora_lookup_by_scientific(scientific_name: str) -> Optional[Dict[str, Any]]:
    """Find a Flora record by scientific name. Returns the first exact match or None."""
    candidates = await flora_search(scientific_name)
    target = scientific_name.strip().lower()
    for c in candidates:
        sci = c.get("scientific_name") or c.get("scientificName")
        if isinstance(sci, str) and sci.strip().lower() == target:
            return c
    return candidates[0] if candidates else None


def normalize_flora(record: Dict[str, Any]) -> Dict[str, Any]:
    """Map a Flora record onto the cache-row shape.

    Flora's strengths (per analysis/api-notes.md): hardiness zones, US-native
    flags, county-level distribution, sun/water requirements. Field names here
    follow the documented shape — defensive against schema drift.
    """
    sci = record.get("scientific_name") or record.get("scientificName") or ""
    common = record.get("common_name") or record.get("commonName") or record.get("name")

    sun_raw = (record.get("sun_exposure") or record.get("sunlight") or "").lower()
    sunlight = None
    if "full sun" in sun_raw or sun_raw == "full_sun":
        sunlight = "full_sun"
    elif "part" in sun_raw or "shade" in sun_raw and "deep" not in sun_raw:
        sunlight = "part_shade"
    elif "deep shade" in sun_raw or "full shade" in sun_raw:
        sunlight = "full_shade"

    water_raw = (record.get("water_needs") or record.get("watering") or "").lower()
    watering = None
    if "high" in water_raw or "frequent" in water_raw:
        watering = "frequent"
    elif "moderate" in water_raw or "average" in water_raw or "medium" in water_raw:
        watering = "average"
    elif "low" in water_raw or "drought" in water_raw or "minimum" in water_raw:
        watering = "minimum"
    elif water_raw in ("none", "no water"):
        watering = "none"

    duration_raw = (record.get("duration") or record.get("lifecycle") or "").lower()
    cycle = None
    if "annual" in duration_raw:
        cycle = "annual"
    elif "biennial" in duration_raw:
        cycle = "biennial"
    elif "perennial" in duration_raw:
        cycle = "perennial"

    hardiness_raw = record.get("hardiness_zone") or record.get("hardinessZone")
    hardiness_min: Optional[int] = None
    hardiness_max: Optional[int] = None
    if isinstance(hardiness_raw, str) and "-" in hardiness_raw:
        try:
            lo, hi = hardiness_raw.split("-", 1)
            hardiness_min = int("".join(ch for ch in lo if ch.isdigit()) or "0") or None
            hardiness_max = int("".join(ch for ch in hi if ch.isdigit()) or "0") or None
        except ValueError:
            pass

    return {
        "source": "flora",
        "source_id": str(record.get("id") or record.get("plant_id") or ""),
        "scientific_name": sci,
        "common_name": common,
        "family": record.get("family"),
        "hardiness_min": hardiness_min,
        "hardiness_max": hardiness_max,
        "sunlight": sunlight,
        "watering": watering,
        "cycle": cycle,
        "edible": record.get("edible"),
        "toxicity": record.get("toxicity"),
        "image_regular_url": record.get("image_url") or record.get("imageUrl"),
    }


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
