"""Trip plan management: listing a trip's scraps, wishlist candidates,
adding scraps to a trip, and staging review.

A "plan" is a scrap filed into a trip. Every plan arrives via a URL capture
(or, later, the community pool) — there is no manual place entry.
Scrap-level reads/edits/vibes live in scrap_routes.py.
"""

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    AssignManyRequest,
    AssignRequest,
    ScrapListResponse,
    ScrapResponse,
    TripWishlistResponse,
    TripWishlistScrap,
)
from .scrap_routes import _hydrated_scrap, get_owned_scrap
from .services.hydrate import hydrate_scraps
from .services.places import place_matches_trip_scope


@router.get(
    "/trips/{trip_id}/scraps",
    response_model=ScrapListResponse,
    status_code=200,
    summary="List a trip's scraps",
)
async def list_scraps(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """All scraps in a trip (approved and staged), newest first. Readable by
    the owner and any member."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id)
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("trip_id", trip_id)
        .order("created_at", desc=True)
        .execute()
    )
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, rows.data or [], with_vibes=True)]
    )


@router.get(
    "/trips/{trip_id}/candidates",
    response_model=ScrapListResponse,
    status_code=200,
    summary="Wishlist places that fit a trip's scope",
)
async def list_trip_candidates(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """Unvisited wishlist scraps whose location matches this trip's geographic
    scope (city/country/region) — the 'from your wishlist' panel. Same match
    predicate as auto-staging, so suggestions stay consistent."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("status", ScrapStatus.INBOX)
        .is_("visited_at", "null")
        .order("created_at", desc=True)
        .execute()
    ).data or []
    hydrated = hydrate_scraps(sb, rows)
    candidates = [
        s for s in hydrated
        if place_matches_trip_scope(
            trip,
            lat=s.get("lat"), lng=s.get("lng"),
            city=s.get("place_city"), region=s.get("place_region"),
            country=s.get("place_country"),
        )
    ]
    return ScrapListResponse(scraps=[ScrapResponse(**s) for s in candidates])


@router.get(
    "/trips/{trip_id}/wishlist",
    response_model=TripWishlistResponse,
    status_code=200,
    summary="Wishlist places to add to a trip (with a scope-fit flag)",
)
async def list_trip_wishlist(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TripWishlistResponse:
    """Every unvisited wishlist scrap, each flagged whether it fits this trip's
    scope — powers the trip's 'Add from your Wander List' picker. Unlike
    /candidates this is NOT scope-filtered: you can add anything; matches just
    sort first."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("status", ScrapStatus.INBOX)
        .is_("visited_at", "null")
        .order("created_at", desc=True)
        .execute()
    ).data or []
    hydrated = hydrate_scraps(sb, rows)
    scored = [
        TripWishlistScrap(
            **s,
            fits_scope=place_matches_trip_scope(
                trip,
                lat=s.get("lat"), lng=s.get("lng"),
                city=s.get("place_city"), region=s.get("place_region"),
                country=s.get("place_country"),
            ),
        )
        for s in hydrated
    ]
    # Scope-matches first; stable sort preserves newest-first within each group.
    scored.sort(key=lambda w: not w.fits_scope)
    return TripWishlistResponse(scraps=scored)


@router.post(
    "/trips/{trip_id}/assign-scraps",
    response_model=ScrapListResponse,
    status_code=200,
    summary="Add several wishlist scraps to a trip",
)
async def assign_scraps(
    body: AssignManyRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """Bulk 'add to trip' from the Wander List picker — files the owned scraps
    into the trip as approved (scope is not enforced; the user chose them)."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    owned = (
        sb.table("travelscrapbook_scraps")
        .select("id")
        .eq("user_id", user.user_id)
        .in_("id", body.scrap_ids)
        .execute()
    ).data or []
    ids = [r["id"] for r in owned]
    if not ids:
        return ScrapListResponse(scraps=[])
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({
            "trip_id": trip_id,
            "status": ScrapStatus.APPROVED,
            "updated_at": "now()",
        })
        .eq("user_id", user.user_id)
        .in_("id", ids)
        .execute()
    )
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, updated.data or [])]
    )


# ── Staging / assignment ─────────────────────────────────────────────────────

@router.post(
    "/scraps/{scrap_id}/assign",
    response_model=ScrapResponse,
    status_code=200,
    summary="Assign a scrap to a trip",
)
async def assign_scrap(
    body: AssignRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """File an inbox (or staged) scrap into a trip as approved — the tap on a
    suggestion chip or the manual trip picker. You may file your own scrap onto
    any trip you own or collaborate on."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    get_accessible_trip(sb, body.trip_id, user.user_id, need_write=True)
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({
            "trip_id": body.trip_id,
            "status": ScrapStatus.APPROVED,
            "updated_at": "now()",
        })
        .eq("id", scrap_id)
        .execute()
    )
    return _hydrated_scrap(sb, updated.data[0])


@router.post(
    "/scraps/{scrap_id}/approve",
    response_model=ScrapResponse,
    status_code=200,
    summary="Approve a staged scrap",
)
async def approve_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Confirm an auto-staged scrap into its trip."""
    sb = get_supabase()
    existing = get_owned_scrap(sb, scrap_id, user.user_id)
    if existing["status"] != ScrapStatus.STAGED:
        raise HTTPException(status_code=409, detail="Scrap is not staged")
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({"status": ScrapStatus.APPROVED, "updated_at": "now()"})
        .eq("id", scrap_id)
        .execute()
    )
    return _hydrated_scrap(sb, updated.data[0])


@router.post(
    "/scraps/{scrap_id}/unassign",
    response_model=ScrapResponse,
    status_code=200,
    summary="Move a scrap back to the inbox",
)
async def unassign_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Remove a scrap from its trip (staging 'remove' or pulling an approved
    scrap back out); it returns to the inbox. Trip-specific state — route
    position and timeline slot — clears with it."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({
            "trip_id": None,
            "status": ScrapStatus.INBOX,
            "route_position": None,
            "plan_date": None,
            "plan_time": None,
            "updated_at": "now()",
        })
        .eq("id", scrap_id)
        .execute()
    )
    return _hydrated_scrap(sb, updated.data[0])


@router.post(
    "/trips/{trip_id}/approve-all",
    response_model=ScrapListResponse,
    status_code=200,
    summary="Approve all staged scraps in a trip",
)
async def approve_all_staged(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """One-tap review: every staged scrap the caller added to the trip becomes
    approved. Scoped to the caller's own scraps so one collaborator can't
    approve another's staged places."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({"status": ScrapStatus.APPROVED, "updated_at": "now()"})
        .eq("trip_id", trip_id)
        .eq("user_id", user.user_id)
        .eq("status", ScrapStatus.STAGED)
        .execute()
    )
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, updated.data or [])]
    )
