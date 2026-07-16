"""Canonical places: normalization, dedupe, and trip matching.

The place is the source of truth — one row per real-world POI per user — and
sources attach to it. Dedupe is name-first (normalized-name match, confirmed by
proximity or city agreement), never coordinate-only: two different POIs can
share a building, but the same POI rarely arrives under two unrelated names.
Per-user scope for now; places.osm_type/osm_id record Nominatim's OSM identity
as the forward path to global cross-user dedupe.
"""

import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from supabase import Client

from ..constants import (
    GeocodeConfidence,
    MAX_TRIP_SUGGESTIONS,
    PLACE_DEDUPE_RADIUS_KM,
    TRIP_MATCH_RADIUS_KM,
    TRIP_SUGGEST_RADIUS_KM,
)
from . import nominatim
from .llm import PlaceExtraction
from .optimizer import haversine_km

logger = logging.getLogger("travel_scrapbook.places")

# Tracking params stripped during URL normalization (never identity-bearing).
_TRACKING_PARAMS = re.compile(r"^(utm_\w+|fbclid|gclid|igsh|igshid|si|ref|ref_src)$", re.I)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize_url(url: str) -> str:
    """Canonical form for source dedupe: lowercase host, no www/fragment/
    tracking params, no trailing slash, scheme dropped."""
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = parsed.path.rstrip("/")
    query_pairs = [
        (k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if not _TRACKING_PARAMS.match(k)
    ]
    query = urlencode(sorted(query_pairs))
    return urlunparse(("", host, path, "", query, "")).lstrip("/")


def normalize_place_name(name: str) -> str:
    """Fold accents/case/punctuation so 'Pastéis de Belém' == 'pasteis de belem'."""
    folded = unicodedata.normalize("NFKD", name)
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    folded = _NON_ALNUM.sub(" ", folded.lower()).strip()
    return folded.removeprefix("the ").strip()


def source_domain(url: str) -> str:
    host = urlparse(url).hostname or ""
    return host.removeprefix("www.")


def find_or_create_place(
    sb: Client,
    user_id: str,
    extraction: PlaceExtraction,
    geo: Optional[nominatim.GeocodeResult],
    confidence: GeocodeConfidence,
    maps_url: Optional[str],
) -> tuple[dict[str, Any], bool]:
    """Return (place row, created?) — deduping against the user's existing places.

    Merge rule: same normalized name AND (both geocoded within
    PLACE_DEDUPE_RADIUS_KM, or coords unavailable on either side with the city
    matching / absent). On merge, NULL fields on the existing row are filled in
    from the new extraction.
    """
    if not extraction.place_name:
        raise ValueError("extraction has no place_name")
    name_norm = normalize_place_name(extraction.place_name)

    candidates = (
        sb.table("travelscrapbook_places")
        .select("*")
        .eq("user_id", user_id)
        .eq("name_normalized", name_norm)
        .execute()
    ).data or []

    new_lat = geo.lat if geo else None
    new_lng = geo.lng if geo else None

    for cand in candidates:
        if cand["lat"] is not None and new_lat is not None:
            if haversine_km(cand["lat"], cand["lng"], new_lat, new_lng) > PLACE_DEDUPE_RADIUS_KM:
                continue
        else:
            cand_city = (cand.get("city") or "").strip().lower()
            new_city = (extraction.city or "").strip().lower()
            if cand_city and new_city and cand_city != new_city:
                continue
        # Merge: fill any gaps on the existing place from this extraction.
        fills: dict[str, Any] = {}
        if cand.get("city") is None and extraction.city:
            fills["city"] = extraction.city
        if cand.get("country") is None and extraction.country:
            fills["country"] = extraction.country
        if cand["lat"] is None and new_lat is not None:
            fills.update({
                "lat": new_lat,
                "lng": new_lng,
                "geocode_confidence": confidence,
                "geocode_display_name": geo.display_name if geo else None,
                "osm_type": geo.osm_type if geo else None,
                "osm_id": geo.osm_id if geo else None,
            })
        if cand.get("maps_url") is None and maps_url:
            fills["maps_url"] = maps_url
        if fills:
            fills["updated_at"] = "now()"
            updated = (
                sb.table("travelscrapbook_places")
                .update(fills)
                .eq("id", cand["id"])
                .execute()
            )
            return updated.data[0], False
        return cand, False

    row = {
        "user_id": user_id,
        "name": extraction.place_name,
        "name_normalized": name_norm,
        "city": extraction.city,
        "country": extraction.country,
        "category": extraction.category,
        "lat": new_lat,
        "lng": new_lng,
        "geocode_confidence": confidence if geo else GeocodeConfidence.NONE,
        "geocode_display_name": geo.display_name if geo else None,
        "osm_type": geo.osm_type if geo else None,
        "osm_id": geo.osm_id if geo else None,
        "maps_url": maps_url,
    }
    created = sb.table("travelscrapbook_places").insert(row).execute()
    return created.data[0], True


def _geocoded_trips(sb: Client, user_id: str) -> list[dict[str, Any]]:
    rows = (
        sb.table("travelscrapbook_trips")
        .select("id, name, cover_icon, lat, lng, end_date")
        .eq("user_id", user_id)
        .not_.is_("lat", "null")
        .execute()
    )
    return rows.data or []


def _is_upcoming(trip: dict[str, Any]) -> bool:
    end = trip.get("end_date")
    if not end:
        return True  # undated trips are treated as active planning
    return end >= datetime.now(timezone.utc).date().isoformat()


def match_trip(sb: Client, user_id: str, lat: float, lng: float) -> Optional[dict[str, Any]]:
    """Nearest trip whose destination is within TRIP_MATCH_RADIUS_KM.

    Upcoming/undated trips win over past ones regardless of distance.
    """
    best: Optional[tuple[bool, float, dict[str, Any]]] = None
    for trip in _geocoded_trips(sb, user_id):
        d = haversine_km(lat, lng, trip["lat"], trip["lng"])
        if d > TRIP_MATCH_RADIUS_KM:
            continue
        key = (not _is_upcoming(trip), d)  # upcoming first, then nearest
        if best is None or key < (best[0], best[1]):
            best = (key[0], key[1], trip)
    return best[2] if best else None


def suggest_trips(
    sb: Client, user_id: str, lat: Optional[float], lng: Optional[float]
) -> list[dict[str, Any]]:
    """Nearest trips within TRIP_SUGGEST_RADIUS_KM, for inbox suggestion chips."""
    if lat is None or lng is None:
        return []
    scored = []
    for trip in _geocoded_trips(sb, user_id):
        d = haversine_km(lat, lng, trip["lat"], trip["lng"])
        if d <= TRIP_SUGGEST_RADIUS_KM:
            scored.append((not _is_upcoming(trip), d, trip))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [
        {
            "trip_id": t["id"],
            "name": t["name"],
            "cover_icon": t.get("cover_icon") or "plane",
            "distance_km": round(d, 1),
        }
        for _, d, t in scored[:MAX_TRIP_SUGGESTIONS]
    ]


async def geocode_trip_destination(sb: Client, trip: dict[str, Any]) -> dict[str, Any]:
    """Geocode a trip's destination text and persist the result.

    Always stamps destination_geocoded_at — even on a miss — so the lazy
    backfill never re-hammers Nominatim for unresolvable destinations.
    """
    update: dict[str, Any] = {
        "destination_geocoded_at": "now()",
        "lat": None,
        "lng": None,
        "geocode_confidence": GeocodeConfidence.NONE,
        "geocode_display_name": None,
    }
    destination = (trip.get("destination") or "").strip()
    if destination:
        result = await nominatim.geocode(destination)
        if result:
            update.update({
                "lat": result.lat,
                "lng": result.lng,
                "geocode_confidence": GeocodeConfidence.HIGH,
                "geocode_display_name": result.display_name,
            })
        else:
            logger.info("trip %s: destination %r did not geocode", trip.get("id"), destination)
    updated = (
        sb.table("travelscrapbook_trips")
        .update(update)
        .eq("id", trip["id"])
        .execute()
    )
    return updated.data[0] if updated.data else {**trip, **update}
