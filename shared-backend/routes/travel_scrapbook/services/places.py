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
    TripScope,
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

    # Nominatim is authoritative for a geocoded point, so prefer its structured
    # address components; fall back to the (noisier) LLM city/country where the
    # geocode is missing a field. region has no LLM source — it stays NULL on a
    # geocode miss, which just means no region-scope match until re-pinned.
    resolved_city = (geo.city if geo and geo.city else None) or extraction.city
    resolved_region = geo.region if geo and geo.region else None
    resolved_country = (geo.country if geo and geo.country else None) or extraction.country

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
        # Merge: fill any gaps on the existing place from this extraction/geocode.
        fills: dict[str, Any] = {}
        if cand.get("city") is None and resolved_city:
            fills["city"] = resolved_city
        if cand.get("region") is None and resolved_region:
            fills["region"] = resolved_region
        if cand.get("country") is None and resolved_country:
            fills["country"] = resolved_country
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
        "city": resolved_city,
        "region": resolved_region,
        "country": resolved_country,
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
        .select("id, name, cover_icon, lat, lng, end_date, "
                "scope_level, dest_city, dest_region, dest_country")
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


def _geo_eq(a: Optional[str], b: Optional[str]) -> bool:
    """Casefold-equality for place-name tags (country/region), both non-empty."""
    return bool(a) and bool(b) and a.strip().casefold() == b.strip().casefold()


def scope_from_addresstype(addresstype: Optional[str]) -> TripScope:
    """Infer a trip's default scope from the geocoded destination's feature level."""
    if addresstype == "country":
        return TripScope.COUNTRY
    if addresstype in ("state", "region", "province", "state_district"):
        return TripScope.REGION
    return TripScope.CITY


def place_matches_trip_scope(
    trip: dict[str, Any],
    *,
    lat: Optional[float],
    lng: Optional[float],
    city: Optional[str],
    region: Optional[str],
    country: Optional[str],
) -> bool:
    """Does a place belong to a trip, given the trip's geographic scope?

    The single source of truth for auto-staging, inbox suggestions, and the
    trip candidates panel. City scope is distance-based (as before); country and
    region scope are tag equality (region additionally requires country
    agreement to keep e.g. Georgia-the-state out of Georgia-the-country).
    """
    level = trip.get("scope_level") or TripScope.CITY
    if level == TripScope.COUNTRY:
        return _geo_eq(country, trip.get("dest_country"))
    if level == TripScope.REGION:
        if not _geo_eq(region, trip.get("dest_region")):
            return False
        # Lenient when either country is unknown; strict when both are present.
        dest_country = trip.get("dest_country")
        return not country or not dest_country or _geo_eq(country, dest_country)
    # city (default): within the destination-centroid radius, OR the same city
    # name (country-guarded) — the latter catches places whose geocode centroid
    # drifted past the radius but that are clearly in the trip's city.
    dest_country = trip.get("dest_country")
    if (
        _geo_eq(city, trip.get("dest_city"))
        and (not country or not dest_country or _geo_eq(country, dest_country))
    ):
        return True
    if lat is None or lng is None or trip.get("lat") is None:
        return False
    return haversine_km(lat, lng, trip["lat"], trip["lng"]) <= TRIP_MATCH_RADIUS_KM


def match_trip(sb: Client, user_id: str, place: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The best trip a place should auto-stage onto, honoring each trip's scope.

    Upcoming/undated trips win over past ones; ties break on centroid distance.
    """
    lat, lng = place.get("lat"), place.get("lng")
    best: Optional[tuple[bool, float, dict[str, Any]]] = None
    for trip in _geocoded_trips(sb, user_id):
        if not place_matches_trip_scope(
            trip, lat=lat, lng=lng,
            city=place.get("city"), region=place.get("region"), country=place.get("country"),
        ):
            continue
        d = (
            haversine_km(lat, lng, trip["lat"], trip["lng"])
            if lat is not None and lng is not None and trip.get("lat") is not None
            else float("inf")
        )
        key = (not _is_upcoming(trip), d)  # upcoming first, then nearest
        if best is None or key < (best[0], best[1]):
            best = (key[0], key[1], trip)
    return best[2] if best else None


def suggest_trips(
    sb: Client,
    user_id: str,
    *,
    lat: Optional[float],
    lng: Optional[float],
    city: Optional[str] = None,
    region: Optional[str] = None,
    country: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Trips to suggest for an inbox scrap: country/region trips by tag match,
    city trips within the (wider) suggestion radius."""
    scored: list[tuple[bool, float, dict[str, Any]]] = []
    for trip in _geocoded_trips(sb, user_id):
        level = trip.get("scope_level") or TripScope.CITY
        d = (
            haversine_km(lat, lng, trip["lat"], trip["lng"])
            if lat is not None and lng is not None and trip.get("lat") is not None
            else None
        )
        if level in (TripScope.COUNTRY, TripScope.REGION):
            matched = place_matches_trip_scope(
                trip, lat=lat, lng=lng, city=city, region=region, country=country)
        else:
            matched = d is not None and d <= TRIP_SUGGEST_RADIUS_KM
        if matched:
            scored.append((not _is_upcoming(trip), d if d is not None else float("inf"), trip))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [
        {
            "trip_id": t["id"],
            "name": t["name"],
            "cover_icon": t.get("cover_icon") or "plane",
            "distance_km": round(d, 1) if d != float("inf") else 0.0,
        }
        for _, d, t in scored[:MAX_TRIP_SUGGESTIONS]
    ]


async def geocode_trip_destination(
    sb: Client, trip: dict[str, Any], *, infer_scope: bool = False
) -> dict[str, Any]:
    """Geocode a trip's destination text and persist the result.

    Also records the structured address components (dest_city/dest_region/
    dest_country) that scope matching reads. When ``infer_scope`` is set (create
    with no explicit level, or legacy backfill), the scope level is inferred from
    the destination's feature type. Always stamps destination_geocoded_at — even
    on a miss — so the lazy backfill never re-hammers Nominatim.
    """
    update: dict[str, Any] = {
        "destination_geocoded_at": "now()",
        "lat": None,
        "lng": None,
        "geocode_confidence": GeocodeConfidence.NONE,
        "geocode_display_name": None,
        "dest_city": None,
        "dest_region": None,
        "dest_country": None,
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
                "dest_city": result.city,
                "dest_region": result.region,
                "dest_country": result.country,
            })
            if infer_scope:
                update["scope_level"] = scope_from_addresstype(result.addresstype)
        else:
            logger.info("trip %s: destination %r did not geocode", trip.get("id"), destination)
    updated = (
        sb.table("travelscrapbook_trips")
        .update(update)
        .eq("id", trip["id"])
        .execute()
    )
    return updated.data[0] if updated.data else {**trip, **update}
