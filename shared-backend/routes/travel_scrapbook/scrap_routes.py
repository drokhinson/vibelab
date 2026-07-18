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
from .dependencies import CurrentUser, get_current_user
from .models import (
    GeoFacets,
    MessageResponse,
    PlanScheduleRequest,
    RatingRequest,
    ScrapResponse,
    ScrapUpdateRequest,
    VibeRequest,
    VisitedPageResponse,
)
from .services.places import build_maps_url
from .services.hydrate import attach_consensus, hydrate_scraps
from .services.places import (
    normalize_place_name,
    resolve_maps_place,
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


def _hydrated_membership(sb, scrap_id: str, trip_id: str) -> ScrapResponse:
    """Return a scrap in ONE trip's context (membership fields + per-trip vibes)
    in a single RPC round-trip. Used by the membership-scoped endpoints
    (assign / approve / schedule / vibe) to echo the updated card."""
    row = (
        sb.rpc(
            "travelscrapbook_scrap_card",
            {"p_scrap_id": scrap_id, "p_trip_id": trip_id},
        ).execute()
    ).data
    if not row:
        raise HTTPException(status_code=404, detail="This place isn't on that trip")
    attach_consensus([row])
    return ScrapResponse(**row)


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
    response_model=VisitedPageResponse,
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
) -> VisitedPageResponse:
    """One filtered page of the scraps the user marked visited (any trip or
    the wishlist), most-recently-visited first — with the visited checkpoint
    places (hotels/transport, 020) split into their own section — plus
    drill-down facets (regions → countries → cities) and the filtered totals.
    Filtering, facets, and pagination all run in SQL (one RPC round-trip)."""
    sb = get_supabase()
    page = (
        sb.rpc("travelscrapbook_visited_page", {
            "p_viewer": user.user_id,
            "p_region": region,
            "p_country": country,
            "p_city": city,
            "p_limit": limit,
            "p_offset": offset,
        }).execute()
    ).data or {}
    return VisitedPageResponse(
        scraps=[ScrapResponse(**s) for s in page.get("scraps", [])],
        visited_checkpoints=[
            ScrapResponse(**s) for s in page.get("visited_checkpoints", [])
        ],
        total=page.get("total", 0),
        checkpoint_total=page.get("checkpoint_total", 0),
        facets=page.get("facets") or GeoFacets(),
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
    """Edit the place name, category, or notes (and the visited/skipped flags).
    Edits write to the scrap's canonical place row (safe — places are per-user).
    City/country/region are read-only here: they derive from the place's pin, so
    the only way to move a place is to pass a new maps_url (city/region/country
    re-derive from it). A plan's per-trip timeline slot is set separately via
    PATCH /scraps/{id}/trips/{trip_id}/schedule."""
    sb = get_supabase()
    existing = get_owned_scrap(sb, scrap_id, user.user_id)
    place = (
        sb.table("travelscrapbook_places")
        .select("*")
        .eq("id", existing["place_id"])
        .execute()
    ).data[0]

    update = body.model_dump(exclude_unset=True)

    scrap_update = {k: update[k] for k in ("notes",) if k in update}
    # visited/skipped are soft timestamp flags, not 1:1 columns — map true→now(),
    # false→NULL. They're mutually exclusive outcomes (the timeline checkbox cycles
    # clear → visited → skipped → clear), so setting one clears the other.
    if "visited" in update:
        scrap_update["visited_at"] = "now()" if update["visited"] else None
        if update["visited"]:
            scrap_update["skipped_at"] = None
    if "skipped" in update:
        scrap_update["skipped_at"] = "now()" if update["skipped"] else None
        if update["skipped"]:
            scrap_update["visited_at"] = None
    place_update: dict[str, Any] = {}
    if update.get("place_name"):
        place_update["name"] = update["place_name"]
        place_update["name_normalized"] = normalize_place_name(update["place_name"])
    if update.get("category"):
        place_update["category"] = update["category"]

    merged = {
        "name": place_update.get("name", place["name"]),
        "city": place_update.get("city", place.get("city")),
        "country": place_update.get("country", place.get("country")),
    }

    # A pasted Google Maps link parses to itself: pull coords + city/region/
    # country straight from the URL (no AI). This is the only path that moves a
    # place — the location fields re-derive from the pin.
    if "maps_url" in update:
        raw = update["maps_url"]
        resolved = await resolve_maps_place(sb, raw) if raw else None
        if resolved:
            place_update["maps_url"] = resolved.maps_url
            if resolved.lat is not None:
                place_update.update({
                    "lat": resolved.lat,
                    "lng": resolved.lng,
                    "city": resolved.city,
                    "country": resolved.country,
                    "country_code": resolved.country_code,
                    "region": resolved.region,
                    "geocode_confidence": resolved.geocode_confidence,
                    "geocode_display_name": resolved.geocode_display_name,
                })
        else:
            # Empty clears it; a non-Maps / unparseable link is stored verbatim
            # (the "open in Maps" button still works) without touching location.
            place_update["maps_url"] = raw or None

    # Rebuild the generated search link only when the user didn't supply their
    # own maps_url this edit (whether it resolved or was stored verbatim).
    if place_update and merged["name"] and "maps_url" not in place_update:
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
    # Plan memberships only (020) — vibes are consensus on PLANS; checkpoint
    # memberships never carry vibe rows.
    memberships = (
        sb.table("travelscrapbook_scrap_trips")
        .select("id")
        .eq("scrap_id", scrap_id)
        .is_("role", "null")
        .execute()
    ).data or []
    if memberships:
        # One bulk upsert covers every trip the place is in (was one per trip).
        sb.table("travelscrapbook_scrap_vibes").upsert(
            [
                {
                    "scrap_trip_id": m["id"],
                    "user_id": user.user_id,
                    "level": body.level,
                    "updated_at": "now()",
                }
                for m in memberships
            ],
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
            .is_("role", "null")
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
