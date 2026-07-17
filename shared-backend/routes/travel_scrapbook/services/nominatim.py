"""Nominatim (OpenStreetMap) geocoding — free, no API key.

Usage policy compliance (https://operations.osmfoundation.org/policies/nominatim/):
  - absolute maximum 1 request/second → module-level lock enforces ≥1.1s spacing
  - descriptive User-Agent identifying the application
  - results cached (30 days) so repeat queries never hit the service
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import httpx

import cache
from api_logger import log_external_call

from ..constants import APP_NAME, CACHE_NS_GEOCODE, GEOCODE_TTL_SECONDS

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
HTTP_TIMEOUT = 10.0
MIN_INTERVAL_SECONDS = 1.1

_USER_AGENT = "vibelab-travel-scrapbook/1.0 (drokhinson@gmail.com)"

_throttle_lock = asyncio.Lock()
_last_call_monotonic = 0.0

cache.configure(CACHE_NS_GEOCODE, max_entries=5000)

# Sentinel cached for queries Nominatim couldn't resolve, so repeated misses
# don't re-hit the service.
_MISS = "__miss__"


@dataclass
class GeocodeResult:
    lat: float
    lng: float
    display_name: str
    # OSM identity of the matched feature — the future key for global
    # (cross-user) place dedupe. Optional: not every response carries it.
    osm_type: Optional[str] = None
    osm_id: Optional[int] = None
    # Structured address components (from Nominatim addressdetails=1). Nominatim
    # is authoritative for a geocoded point, so these seed a place's
    # city/region/country and a trip's derived scope. region == admin-1 (state /
    # province / named region). addresstype names the matched feature's level
    # (e.g. 'country', 'state', 'city') — used to infer a trip's scope level.
    city: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    country_code: Optional[str] = None
    addresstype: Optional[str] = None


def _parse_row(row: dict) -> Optional[GeocodeResult]:
    """Map one Nominatim result row (search or reverse) to a GeocodeResult."""
    address = row.get("address") or {}
    try:
        return GeocodeResult(
            lat=float(row["lat"]),
            lng=float(row["lon"]),
            display_name=str(row.get("display_name", "")),
            osm_type=str(row["osm_type"]) if row.get("osm_type") else None,
            osm_id=int(row["osm_id"]) if row.get("osm_id") is not None else None,
            city=(
                address.get("city")
                or address.get("town")
                or address.get("village")
                or address.get("municipality")
            ),
            region=(
                address.get("state")
                or address.get("region")
                or address.get("province")
                or address.get("state_district")
            ),
            country=address.get("country"),
            country_code=address.get("country_code"),
            addresstype=row.get("addresstype"),
        )
    except (KeyError, TypeError, ValueError):
        return None


async def _throttled_get(url: str, params: dict) -> Optional[object]:
    """One rate-limited Nominatim request. Returns parsed JSON, or None on any
    network/HTTP error (geocoding is always best-effort)."""
    global _last_call_monotonic
    async with _throttle_lock:
        wait = MIN_INTERVAL_SECONDS - (time.monotonic() - _last_call_monotonic)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call_monotonic = time.monotonic()

        try:
            async with log_external_call(
                app=APP_NAME,
                api_name="nominatim",
                method="GET",
                url=url,
                params=params,
            ) as record:
                async with httpx.AsyncClient(
                    timeout=HTTP_TIMEOUT,
                    headers={"User-Agent": _USER_AGENT},
                ) as client:
                    resp = await client.get(url, params=params)
                record.attach_response(resp)
                resp.raise_for_status()
                return resp.json()
        except (httpx.HTTPError, ValueError):
            return None


async def geocode(query: str) -> Optional[GeocodeResult]:
    """Resolve a freeform place query to coordinates, or None on no match.

    Network/HTTP errors also return None — geocoding is always best-effort.
    """
    key = " ".join(query.lower().split())
    if not key:
        return None
    cached = cache.get(CACHE_NS_GEOCODE, key)
    if cached is not None:
        return None if cached == _MISS else cached

    rows = await _throttled_get(NOMINATIM_URL, {
        "q": query,
        "format": "jsonv2",
        "limit": "1",
        "addressdetails": "1",
        # Return names in English where an exonym exists (falls back to the
        # local name otherwise) so cards/groupings read "Greece" not "Ελλάς".
        "accept-language": "en",
    })
    if rows is None:
        return None
    if not rows:
        cache.set(CACHE_NS_GEOCODE, key, _MISS, GEOCODE_TTL_SECONDS)
        return None

    result = _parse_row(rows[0])
    if result is None:
        return None
    cache.set(CACHE_NS_GEOCODE, key, result, GEOCODE_TTL_SECONDS)
    return result


async def reverse(lat: float, lng: float) -> Optional[GeocodeResult]:
    """Resolve coordinates to a place (city/region/country + display name), or
    None on no match. Used when a Google Maps URL already carries the exact pin —
    reverse-geocoding that point is more reliable than forward-geocoding a
    'lat,lng' string. Best-effort: network/HTTP errors return None."""
    key = f"reverse:{lat:.5f},{lng:.5f}"
    cached = cache.get(CACHE_NS_GEOCODE, key)
    if cached is not None:
        return None if cached == _MISS else cached

    row = await _throttled_get(NOMINATIM_REVERSE_URL, {
        "lat": f"{lat}",
        "lon": f"{lng}",
        "format": "jsonv2",
        "addressdetails": "1",
        "accept-language": "en",
    })
    if row is None:
        return None
    # /reverse returns a single object (or {"error": ...}), not a list.
    if not isinstance(row, dict) or "lat" not in row:
        cache.set(CACHE_NS_GEOCODE, key, _MISS, GEOCODE_TTL_SECONDS)
        return None

    result = _parse_row(row)
    if result is None:
        return None
    cache.set(CACHE_NS_GEOCODE, key, result, GEOCODE_TTL_SECONDS)
    return result
