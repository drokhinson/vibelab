"""Scrap-level reads, edits, deletion, the visited list, and vibes.

Creation happens via POST /capture (source_routes) — one URL can fan out into
several scraps. Trip-plan management (adding scraps to trips, staging review)
lives in plan_routes.py.
"""

from typing import Any, Optional

from fastapi import Depends, HTTPException, Path, Query

from db import get_supabase

from . import router
from .access import get_accessible_membership
from .constants import GeocodeConfidence
from .dependencies import CurrentUser, get_current_user
from .models import (
    MessageResponse,
    PagedScrapsResponse,
    PlanScheduleRequest,
    RatingRequest,
    ScrapResponse,
    ScrapUpdateRequest,
    VibeRequest,
)
from .services import nominatim
from .services.enrichment import build_maps_url
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps
from .services.places import (
    geo_facets,
    geo_match,
    normalize_place_name,
    region_for_country_code,
)


def get_owned_scrap(sb, scrap_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("id", scrap_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Scrap not found")
    return rows.data[0]


def _hydrated_scrap(sb, scrap: dict[str, Any], *, with_vibes: bool = False) -> ScrapResponse:
    return ScrapResponse(**hydrate_scraps(sb, [scrap], with_vibes=with_vibes)[0])


def _hydrated_membership(
    sb, scrap_id: str, trip_id: str, *, with_vibes: bool = True
) -> ScrapResponse:
    """Return a scrap in ONE trip's context (membership fields + per-trip vibes).
    Used by the membership-scoped endpoints (assign / approve / schedule / vibe)."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*, travelscrapbook_scraps(*)")
        .eq("scrap_id", scrap_id)
        .eq("trip_id", trip_id)
        .execute()
    ).data or []
    flat = membership_rows_to_scraps(rows)
    if not flat:
        raise HTTPException(status_code=404, detail="This place isn't on that trip")
    return ScrapResponse(**hydrate_scraps(sb, flat, with_vibes=with_vibes)[0])


@router.get(
    "/scraps/{scrap_id}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Get one scrap",
)
async def get_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Fetch a single scrap with its place and sources."""
    sb = get_supabase()
    return _hydrated_scrap(sb, get_owned_scrap(sb, scrap_id, user.user_id))


@router.get(
    "/visited",
    response_model=PagedScrapsResponse,
    status_code=200,
    summary="Places you've marked visited",
)
async def list_visited(
    region: Optional[str] = Query(None, max_length=120, description="Filter: macro-region"),
    country: Optional[str] = Query(None, max_length=120, description="Filter: country (within the region)"),
    city: Optional[str] = Query(None, max_length=120, description="Filter: city (within the country)"),
    limit: int = Query(24, ge=1, le=100, description="Page size"),
    offset: int = Query(0, ge=0, description="Page start"),
    user: CurrentUser = Depends(get_current_user),
) -> PagedScrapsResponse:
    """One filtered page of the scraps the user marked visited (any trip or
    the wishlist), most-recently-visited first, plus drill-down facets
    (regions → countries → cities) and the filtered total."""
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*, travelscrapbook_places(region, country, city)")
        .eq("user_id", user.user_id)
        .not_.is_("visited_at", "null")
        .order("visited_at", desc=True)
        .execute()
    ).data or []
    geo_rows = []
    for r in rows:
        place = r.pop("travelscrapbook_places", None) or {}
        geo_rows.append({
            **r,
            "place_region": place.get("region"),
            "place_country": place.get("country"),
            "place_city": place.get("city"),
        })
    facets = geo_facets(geo_rows, region=region, country=country)
    filtered = [
        r for r in geo_rows
        if geo_match(r, region=region, country=country, city=city)
    ]
    page = hydrate_scraps(sb, [
        {k: v for k, v in r.items()
         if k not in ("place_region", "place_country", "place_city")}
        for r in filtered[offset:offset + limit]
    ])
    return PagedScrapsResponse(
        scraps=[ScrapResponse(**s) for s in page],
        total=len(filtered),
        facets=facets,
    )


@router.patch(
    "/scraps/{scrap_id}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Edit a scrap",
)
async def update_scrap(
    body: ScrapUpdateRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Edit place fields, category, or notes (and the visited flag). Place edits
    write to the scrap's canonical place row (safe — places are per-user). A
    plan's per-trip timeline slot is set separately via
    PATCH /scraps/{id}/trips/{trip_id}/schedule. Pass regeocode=true to re-run
    Nominatim on the (possibly edited) place."""
    sb = get_supabase()
    existing = get_owned_scrap(sb, scrap_id, user.user_id)
    place = (
        sb.table("travelscrapbook_places")
        .select("*")
        .eq("id", existing["place_id"])
        .execute()
    ).data[0]

    update = body.model_dump(exclude_unset=True, exclude={"regeocode"})

    scrap_update = {k: update[k] for k in ("notes",) if k in update}
    # visited is a soft timestamp flag, not a 1:1 column — map true→now(), false→NULL.
    if "visited" in update:
        scrap_update["visited_at"] = "now()" if update["visited"] else None
    place_update: dict[str, Any] = {}
    if update.get("place_name"):
        place_update["name"] = update["place_name"]
        place_update["name_normalized"] = normalize_place_name(update["place_name"])
    if "place_city" in update:
        place_update["city"] = update["place_city"]
    if "place_country" in update:
        place_update["country"] = update["place_country"]
    if update.get("category"):
        place_update["category"] = update["category"]

    merged = {
        "name": place_update.get("name", place["name"]),
        "city": place_update.get("city", place.get("city")),
        "country": place_update.get("country", place.get("country")),
    }

    if body.regeocode and merged["name"]:
        query = ", ".join(p for p in merged.values() if p)
        result = await nominatim.geocode(query)
        if result:
            place_update.update({
                "lat": result.lat,
                "lng": result.lng,
                "geocode_confidence": GeocodeConfidence.HIGH,
                "geocode_display_name": result.display_name,
                "osm_type": result.osm_type,
                "osm_id": result.osm_id,
                # Re-pinning refreshes the country_code + derived macro-region
                # (and, via accept-language=en, English names) — the path that
                # fixes older local-language places.
                "country_code": result.country_code,
                "region": region_for_country_code(sb, result.country_code),
            })
        else:
            place_update.update({
                "lat": None,
                "lng": None,
                "geocode_confidence": GeocodeConfidence.NONE,
                "geocode_display_name": None,
                "osm_type": None,
                "osm_id": None,
            })

    if place_update and merged["name"]:
        place_update["maps_url"] = build_maps_url(
            merged["name"], merged["city"], merged["country"]
        )

    if place_update:
        place_update["updated_at"] = "now()"
        sb.table("travelscrapbook_places").update(place_update).eq(
            "id", existing["place_id"]
        ).execute()
    if scrap_update:
        scrap_update["updated_at"] = "now()"
        updated = (
            sb.table("travelscrapbook_scraps")
            .update(scrap_update)
            .eq("id", scrap_id)
            .execute()
        )
        existing = updated.data[0]
    return _hydrated_scrap(sb, existing)


@router.delete(
    "/scraps/{scrap_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a scrap",
)
async def delete_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove a saved place (the canonical place row and sources remain)."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scraps").delete().eq("id", scrap_id).execute()
    return MessageResponse(message="Scrap deleted")


# ── Timeline slot (per-trip plan schedule) ──────────────────────────────────

@router.patch(
    "/scraps/{scrap_id}/trips/{trip_id}/schedule",
    response_model=ScrapResponse,
    status_code=200,
    summary="Set a plan's timeline slot on a trip",
)
async def schedule_plan(
    body: PlanScheduleRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Set or clear a place's day (and optional time) on ONE trip's timeline —
    per-membership, so the same place can sit on different days across trips.
    Collaborator-or-owner only; plan_date must fall within the trip's dates."""
    sb = get_supabase()
    membership, _ = get_accessible_membership(
        sb, scrap_id, trip_id, user.user_id, need_write=True
    )
    update = body.model_dump(exclude_unset=True)
    m_update: dict[str, Any] = {}
    for k in ("plan_date", "plan_time"):
        if k in update:
            v = update[k]
            m_update[k] = v.isoformat() if v is not None else None
    plan_date = m_update.get("plan_date")
    if plan_date:
        trip = (
            sb.table("travelscrapbook_trips")
            .select("start_date, end_date")
            .eq("id", trip_id)
            .execute()
        ).data[0]
        start, end = trip.get("start_date"), trip.get("end_date")
        if (start and plan_date < start) or (end and plan_date > end):
            raise HTTPException(
                status_code=400, detail="Plan day must fall within the trip's dates")
    if m_update:
        sb.table("travelscrapbook_scrap_trips").update(m_update).eq(
            "id", membership["id"]
        ).execute()
    return _hydrated_membership(sb, scrap_id, trip_id)


# ── Rating (the owner's own priority on a place) ─────────────────────────────

@router.put(
    "/scraps/{scrap_id}/rating",
    response_model=ScrapResponse,
    status_code=200,
    summary="Rate a place",
)
async def set_rating(
    body: RatingRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Set the owner's priority on their saved place (booked / must do /
    interested / could skip) — from the Wander List or any trip. The rating
    doubles as the owner's vibe on EVERY trip the place is in, so each trip's
    group consensus includes them without a second control."""
    sb = get_supabase()
    scrap = get_owned_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scraps").update(
        {"rating": body.level, "updated_at": "now()"}
    ).eq("id", scrap_id).execute()
    scrap["rating"] = body.level
    memberships = (
        sb.table("travelscrapbook_scrap_trips")
        .select("id")
        .eq("scrap_id", scrap_id)
        .execute()
    ).data or []
    for m in memberships:
        sb.table("travelscrapbook_scrap_vibes").upsert(
            {
                "scrap_trip_id": m["id"],
                "user_id": user.user_id,
                "level": body.level,
                "updated_at": "now()",
            },
            on_conflict="scrap_trip_id,user_id",
        ).execute()
    return _hydrated_scrap(sb, scrap)


@router.delete(
    "/scraps/{scrap_id}/rating",
    response_model=ScrapResponse,
    status_code=200,
    summary="Clear a place's rating",
)
async def clear_rating(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Remove the owner's priority on their place (back to unrated). Also clears
    the owner's vibe row on every trip the place is in, mirroring set_rating."""
    sb = get_supabase()
    scrap = get_owned_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scraps").update(
        {"rating": None, "updated_at": "now()"}
    ).eq("id", scrap_id).execute()
    scrap["rating"] = None
    membership_ids = [
        m["id"]
        for m in (
            sb.table("travelscrapbook_scrap_trips")
            .select("id")
            .eq("scrap_id", scrap_id)
            .execute()
        ).data or []
    ]
    if membership_ids:
        sb.table("travelscrapbook_scrap_vibes").delete().in_(
            "scrap_trip_id", membership_ids
        ).eq("user_id", user.user_id).execute()
    return _hydrated_scrap(sb, scrap)


# ── Vibes (per-traveler, per-trip consensus input) ───────────────────────────

@router.put(
    "/scraps/{scrap_id}/trips/{trip_id}/vibe",
    response_model=ScrapResponse,
    status_code=200,
    summary="Set my vibe on a place for a trip",
)
async def set_vibe(
    body: VibeRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Record (or change) the current traveler's vibe on a place for ONE trip.
    Any member of the trip may set their own — including viewers — so everyone
    contributes to that trip's group consensus."""
    sb = get_supabase()
    membership, _ = get_accessible_membership(sb, scrap_id, trip_id, user.user_id)
    sb.table("travelscrapbook_scrap_vibes").upsert(
        {
            "scrap_trip_id": membership["id"],
            "user_id": user.user_id,
            "level": body.level,
            "updated_at": "now()",
        },
        on_conflict="scrap_trip_id,user_id",
    ).execute()
    return _hydrated_membership(sb, scrap_id, trip_id)


@router.delete(
    "/scraps/{scrap_id}/trips/{trip_id}/vibe",
    response_model=ScrapResponse,
    status_code=200,
    summary="Clear my vibe on a place for a trip",
)
async def clear_vibe(
    scrap_id: str = Path(..., description="Scrap UUID"),
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Remove the current traveler's vibe on a place for one trip."""
    sb = get_supabase()
    membership, _ = get_accessible_membership(sb, scrap_id, trip_id, user.user_id)
    sb.table("travelscrapbook_scrap_vibes").delete().eq(
        "scrap_trip_id", membership["id"]
    ).eq("user_id", user.user_id).execute()
    return _hydrated_membership(sb, scrap_id, trip_id)
