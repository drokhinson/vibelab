"""USDA hardiness-zone lookup from ZIP or lat/lng.

This is a deliberately small, dependency-free service for the prototype:
  • ZIP path: take the first 3 digits, look it up in zip3_to_zone.json.
  • Lat/lng path: nearest ZIP3 centroid in the same file.

The lookup file ships ~1000 entries — every continental-US ZIP3 with the
typical USDA hardiness zone for that region. Precision is "good enough" at
the regional scale (boroughs of NYC all map to the same ZIP3); we can swap
in a denser table or a real third-party API later without touching callers.
"""

from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status

from . import router
from .models import LocationLookupBody, LocationLookupResponse


_DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "zip3_to_zone.json")


@lru_cache(maxsize=1)
def _load_table() -> Dict[str, Dict[str, Any]]:
    """{ '021': { 'zone': '6b', 'zone_number': 6, 'lat': 42.36, 'lng': -71.06, 'state': 'MA' }, ... }

    Strips any keys that don't look like a 3-digit ZIP prefix (e.g. the
    "_comment" string at the top of the JSON file)."""
    with open(_DATA_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return {k: v for k, v in raw.items() if isinstance(v, dict) and len(k) == 3 and k.isdigit()}


def _zone_to_number(zone: str) -> int:
    """'6a' → 6, '10b' → 10. Falls back to 0 if unparseable."""
    digits = ""
    for ch in zone:
        if ch.isdigit():
            digits += ch
        else:
            break
    return int(digits) if digits else 0


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _nearest_zip3(lat: float, lng: float) -> Optional[Tuple[str, Dict[str, Any], float]]:
    """Linear scan of ~1000 centroids — fine at this scale."""
    best: Optional[Tuple[str, Dict[str, Any], float]] = None
    for zip3, row in _load_table().items():
        rlat = row.get("lat")
        rlng = row.get("lng")
        if rlat is None or rlng is None:
            continue
        d = _haversine_km(lat, lng, rlat, rlng)
        if best is None or d < best[2]:
            best = (zip3, row, d)
    return best


@router.post(
    "/location/lookup",
    response_model=LocationLookupResponse,
    status_code=status.HTTP_200_OK,
    summary="Resolve ZIP or lat/lng to a USDA hardiness zone",
)
async def location_lookup(body: LocationLookupBody) -> LocationLookupResponse:
    """Resolve ZIP or lat/lng to a USDA hardiness zone for the New-Garden wizard."""

    table = _load_table()

    # ZIP wins when both are supplied.
    if body.zip:
        zip5 = "".join(ch for ch in body.zip if ch.isdigit())[:5]
        if len(zip5) < 3:
            raise HTTPException(status_code=422, detail="ZIP must have at least 3 digits")
        zip3 = zip5[:3]
        row = table.get(zip3)
        if not row:
            raise HTTPException(status_code=404, detail=f"No hardiness data for ZIP {zip5}")
        zone = row["zone"]
        state = row.get("state") or ""
        label = f"{zip5} · Zone {zone}" if not state else f"{zip5}, {state} · Zone {zone}"
        return LocationLookupResponse(
            zone=zone,
            zone_number=_zone_to_number(zone),
            label=label,
            source="zip",
        )

    if body.lat is not None and body.lng is not None:
        if not (-90 <= body.lat <= 90) or not (-180 <= body.lng <= 180):
            raise HTTPException(status_code=422, detail="lat/lng out of range")
        nearest = _nearest_zip3(body.lat, body.lng)
        if nearest is None:
            raise HTTPException(status_code=404, detail="No hardiness data found near that coordinate")
        zip3, row, _ = nearest
        zone = row["zone"]
        state = row.get("state") or ""
        label = f"Zone {zone}" if not state else f"{state} · Zone {zone}"
        return LocationLookupResponse(
            zone=zone,
            zone_number=_zone_to_number(zone),
            label=label,
            source="geolocation",
        )

    raise HTTPException(status_code=422, detail="Provide either zip or lat+lng")
