"""Checkpoints over the unified model: place + scrap + role-bearing membership.

Since migration 020 a checkpoint is not its own table row — it is a canonical
place (identity), the user's scrap (their saved, visitable copy), and a
travelscrapbook_scrap_trips membership whose ``role`` (start|end|stay|travel)
marks it as a trip checkpoint. This module is the one place that maps between
that storage and the legacy flat "anchor" shape every timeline/route consumer
still reads (services/timeline.py, web/domain/timeline.js, route_planner,
route-panel, trip-timeline, checkpoint-card — none of them changed).

The category ↔ role/type mapping is the unification's type system: the
transport mode (old anchor.type) is a property of the PLACE (its category);
the role is a property of the MEMBERSHIP.
"""

from typing import Any, Optional

from supabase import Client

import cache

from ..constants import (
    AnchorRole,
    AnchorType,
    CACHE_NS_CATEGORIES,
    CATEGORIES_TTL_SECONDS,
    GeocodeConfidence,
)
from . import nominatim
from .llm import PlaceExtraction
from .places import build_maps_url, find_or_create_place, resolve_maps_place

# Transport categories map 1:1 onto the legacy AnchorType vocabulary; lodging
# is the stay category. 'transport' is the generic bucket (type 'other').
_TYPE_TO_CATEGORY = {
    AnchorType.AIRPORT: "airport",
    AnchorType.TRAIN_STATION: "train_station",
    AnchorType.CAR_RENTAL: "car_rental",
    AnchorType.OTHER: "transport",
}
_CATEGORY_TO_TYPE = {
    "airport": AnchorType.AIRPORT,
    "train_station": AnchorType.TRAIN_STATION,
    "car_rental": AnchorType.CAR_RENTAL,
}


def category_for(role: str, type_: Optional[str]) -> str:
    """The place category a checkpoint implies: stay → lodging, travel roles →
    their transport-mode category (generic 'transport' when untyped)."""
    if role == AnchorRole.STAY:
        return "lodging"
    return _TYPE_TO_CATEGORY.get(type_, "transport")


def type_for_category(category: Optional[str]) -> str:
    """The legacy anchor 'type' a travel-role checkpoint reports, from its
    place's category (anything non-transport degrades to 'other')."""
    return _CATEGORY_TO_TYPE.get(category or "", AnchorType.OTHER)


def checkpoint_category_slugs(sb: Client) -> set[str]:
    """Category slugs flagged is_checkpoint (lodging + transport set) — the
    browse/community definitional rule. Cached; empty set on lookup failure so
    callers degrade to 'nothing is a checkpoint' rather than erroring."""
    cached = cache.get(CACHE_NS_CATEGORIES, "checkpoint_slugs")
    if cached is not None:
        return cached
    try:
        rows = (
            sb.table("travelscrapbook_categories")
            .select("slug")
            .eq("is_checkpoint", True)
            .execute()
        ).data or []
    except Exception:
        return set()
    slugs = {r["slug"] for r in rows}
    cache.set(CACHE_NS_CATEGORIES, "checkpoint_slugs", slugs, CATEGORIES_TTL_SECONDS)
    return slugs


def synthesize_anchor(
    membership: dict[str, Any], scrap: dict[str, Any], place: dict[str, Any]
) -> dict[str, Any]:
    """One role-bearing membership + its scrap + place → the flat legacy anchor
    dict. Mirrors the SQL synthesis in travelscrapbook_trip_bundle (020) —
    keep the two in step."""
    role = membership["role"]
    is_stay = role == AnchorRole.STAY
    return {
        "id": membership["id"],
        "trip_id": membership["trip_id"],
        "role": role,
        "label": place["name"],
        "query": place.get("geocode_display_name") or place["name"],
        "lat": place.get("lat"),
        "lng": place.get("lng"),
        "city": place.get("city"),
        "region": place.get("region"),
        "country": place.get("country"),
        "country_code": place.get("country_code"),
        "maps_url": place.get("maps_url"),
        "geocode_confidence": place.get("geocode_confidence") or GeocodeConfidence.NONE,
        "type": None if is_stay else type_for_category(place.get("category")),
        "anchor_date": None if is_stay else membership.get("plan_date"),
        "anchor_time": None if is_stay else membership.get("plan_time"),
        "stay_date": membership.get("plan_date") if is_stay else None,
        "stay_end_date": membership.get("plan_end_date") if is_stay else None,
        "created_at": membership["created_at"],
        "place_id": place["id"],
        "scrap_id": scrap["id"],
    }


def load_trip_anchors(sb: Client, trip_id: str) -> list[dict[str, Any]]:
    """A trip's checkpoints in the legacy anchor shape, ordered by membership
    created_at — the same order route-panel.js resolves 'first stay' by."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*, travelscrapbook_scraps(*, travelscrapbook_places(*))")
        .eq("trip_id", trip_id)
        .not_.is_("role", "null")
        .order("created_at")
        .execute()
    ).data or []
    anchors: list[dict[str, Any]] = []
    for m in rows:
        scrap = m.get("travelscrapbook_scraps") or {}
        place = scrap.get("travelscrapbook_places") or {}
        if scrap and place:
            anchors.append(synthesize_anchor(m, scrap, place))
    return anchors


def get_checkpoint_membership(
    sb: Client, membership_id: str
) -> Optional[dict[str, Any]]:
    """One role-bearing membership with its scrap + place embedded (None when
    the id is unknown or the row is an ordinary plan)."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*, travelscrapbook_scraps(*, travelscrapbook_places(*))")
        .eq("id", membership_id)
        .not_.is_("role", "null")
        .execute()
    ).data or []
    return rows[0] if rows else None


async def resolve_checkpoint_geo(
    sb: Client, *, maps_url: Optional[str], query: Optional[str]
) -> tuple[Optional[nominatim.GeocodeResult], GeocodeConfidence, Optional[str]]:
    """(geo, confidence, maps_url_to_store) for a checkpoint's location. A
    pasted Google Maps URL wins (parsed to itself, no AI); a non-Maps or
    unparseable link is stored verbatim while the text query supplies the pin."""
    if maps_url:
        resolved = await resolve_maps_place(sb, maps_url)
        if resolved is not None and resolved.lat is not None:
            geo = nominatim.GeocodeResult(
                lat=resolved.lat,
                lng=resolved.lng,
                display_name=resolved.geocode_display_name or "",
                city=resolved.city,
                country=resolved.country,
                country_code=resolved.country_code,
            )
            return geo, GeocodeConfidence.HIGH, resolved.maps_url
        keep_url = resolved.maps_url if resolved is not None else maps_url
        geo = await nominatim.geocode(query) if query else None
        return geo, (GeocodeConfidence.HIGH if geo else GeocodeConfidence.NONE), keep_url
    geo = await nominatim.geocode(query) if query else None
    return geo, (GeocodeConfidence.HIGH if geo else GeocodeConfidence.NONE), None


def place_scrap_from_geo(
    sb: Client,
    user_id: str,
    *,
    label: str,
    category: str,
    geo: Optional[nominatim.GeocodeResult],
    confidence: GeocodeConfidence,
    maps_url: Optional[str] = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(place, scrap) from an already-resolved location: dedupe into the
    caller's canonical places (find_or_create_place) and find-or-create their
    scrap. The scrap lands on the Wander List like any saved place."""
    extraction = PlaceExtraction(
        place_name=label,
        city=None,
        country=None,
        category=category,
        geocode_query=None,
        confident=True,
    )
    final_maps = maps_url or build_maps_url(
        label, geo.city if geo else None, geo.country if geo else None
    )
    place, _created = find_or_create_place(
        sb, user_id, extraction, geo, confidence, final_maps
    )

    existing = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user_id)
        .eq("place_id", place["id"])
        .limit(1)
        .execute()
    ).data
    if existing:
        return place, existing[0]
    scrap = (
        sb.table("travelscrapbook_scraps")
        .insert({"user_id": user_id, "place_id": place["id"]})
        .execute()
    ).data[0]
    return place, scrap


async def materialize_checkpoint_scrap(
    sb: Client,
    user_id: str,
    *,
    label: str,
    category: str,
    query: Optional[str] = None,
    maps_url: Optional[str] = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(place, scrap) for a checkpoint: resolve the location, then dedupe and
    save via place_scrap_from_geo."""
    geo, confidence, resolved_url = await resolve_checkpoint_geo(
        sb, maps_url=maps_url, query=query
    )
    return place_scrap_from_geo(
        sb, user_id, label=label, category=category,
        geo=geo, confidence=confidence, maps_url=resolved_url,
    )
