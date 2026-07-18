"""Trip plan management: listing a trip's scraps, wishlist candidates,
adding/removing scraps to/from trips, and staging review.

A "plan" is a place filed into a trip — a row in travelscrapbook_scrap_trips
linking the owner's scrap to the trip (with that trip's status / route position
/ timeline slot). A place can be a plan on several trips at once; it stays on the
owner's Wander List regardless (it only leaves when visited). Every place still
arrives via a URL capture (or the community pool) — there is no manual entry.
Scrap-level reads/edits/vibes live in scrap_routes.py.
"""

from fastapi import Depends, HTTPException, Path, Query
from supabase import Client

from db import get_supabase

from . import router
from .access import assert_writable_trips, get_accessible_membership, get_accessible_trip
from .constants import MembershipStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    AssignManyRequest,
    AssignRequest,
    MessageResponse,
    ScrapListResponse,
    ScrapResponse,
    SetTripsRequest,
    TripSuggestionsResponse,
    TripWishlistResponse,
    TripWishlistScrap,
)
from .scrap_routes import _hydrated_membership, get_owned_scrap
from .services.checkpoints import checkpoint_category_slugs
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps
from .services.places import place_matches_trip_scope


def _trip_memberships(sb, trip_id: str) -> list[dict]:
    """A trip's PLAN memberships (join rows embedding their scrap), newest
    first. Checkpoint memberships (role set, 020) belong to the anchors
    surface, never the plans lists."""
    return (
        sb.table("travelscrapbook_scrap_trips")
        .select("*, travelscrapbook_scraps(*)")
        .eq("trip_id", trip_id)
        .is_("role", "null")
        .order("created_at", desc=True)
        .execute()
    ).data or []


def _trip_scrap_ids(sb, trip_id: str) -> set[str]:
    """The scrap ids already a member of a trip (to exclude from 'add' pickers)."""
    return {
        m["scrap_id"]
        for m in (
            sb.table("travelscrapbook_scrap_trips")
            .select("scrap_id")
            .eq("trip_id", trip_id)
            .execute()
        ).data or []
    }


def _record_dismissals(sb, trip_id: str, scrap_ids: list[str]) -> None:
    """Mark (scrap, trip) pairs as resolved so they don't re-appear as
    suggestions after the place is removed from the trip. Idempotent."""
    if not scrap_ids:
        return
    sb.table("travelscrapbook_scrap_trip_dismissals").upsert(
        [{"scrap_id": sid, "trip_id": trip_id} for sid in scrap_ids],
        on_conflict="scrap_id,trip_id",
        ignore_duplicates=True,
    ).execute()


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
    """Every unvisited wishlist place NOT already in this trip, each flagged
    whether it fits the trip's scope — powers the 'Add from your Wander List'
    picker. Unlike /candidates this is NOT scope-filtered: you can add anything;
    matches just sort first."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    already = _trip_scrap_ids(sb, trip_id)
    rows = [
        r for r in (
            sb.table("travelscrapbook_scraps")
            .select("*")
            .eq("user_id", user.user_id)
            .is_("visited_at", "null")
            .order("created_at", desc=True)
            .execute()
        ).data or []
        if r["id"] not in already
    ]
    hydrated = hydrate_scraps(sb, rows)
    # Same checkpoint exclusion as /candidates: the picker adds PLANS, and a
    # hotel/airport joins a trip as a checkpoint via the trip screen instead.
    cp_slugs = checkpoint_category_slugs(sb)
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
        if s.get("category") not in cp_slugs
    ]
    # Scope-matches first; stable sort preserves newest-first within each group.
    scored.sort(key=lambda w: not w.fits_scope)
    return TripWishlistResponse(scraps=scored)


@router.get(
    "/trips/{trip_id}/suggestions",
    response_model=TripSuggestionsResponse,
    status_code=200,
    summary="Ranked wander + community suggestions for a trip's add picker",
)
async def list_trip_suggestions(
    trip_id: str = Path(..., description="Trip UUID"),
    category: str | None = Query(None, max_length=40, description="Filter by category slug"),
    checkpoints: bool = Query(
        False, description="Draw from the Stays & transport pool (checkpoint "
                           "categories) instead of ordinary plan places"),
    q: str | None = Query(None, max_length=120, description="Search name or city"),
    limit: int = Query(6, ge=1, le=24, description="Page size (one carousel page)"),
    offset: int = Query(0, ge=0, description="Page start"),
    user: CurrentUser = Depends(get_current_user),
) -> TripSuggestionsResponse:
    """The unified 'add to trip' picker feed in one round trip: the viewer's
    Wander List (higher priority) merged with the community pool, scoped to the
    trip's region/country/city, split by the checkpoint partition, optionally
    narrowed to one category, ranked wander-first then nearest to the trip's
    placed plans. `categories` is the type-filter facet over the whole scoped
    pool (independent of the current category pick)."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id)  # 404s if not a member
    result = (
        sb.rpc("travelscrapbook_trip_suggestions", {
            "p_trip_id": trip_id,
            "p_viewer": user.user_id,
            "p_category": category,
            "p_checkpoints": checkpoints,
            "p_q": q,
            "p_limit": limit,
            "p_offset": offset,
        }).execute()
    ).data or {}
    return TripSuggestionsResponse(
        items=result.get("items", []),
        total=result.get("total", 0),
        categories=result.get("categories", []),
    )


def _add_plan_memberships(sb: Client, pairs: list[tuple[str, str]]) -> None:
    """Add PLAN memberships for (scrap_id, trip_id) pairs, leaving any that
    already exist untouched — one RPC round trip however many pairs. An RPC
    because the plan uniqueness is a partial index (WHERE role IS NULL, 020)
    that PostgREST's on_conflict can't arbitrate."""
    if not pairs:
        return
    sb.rpc("travelscrapbook_add_plan_memberships", {
        "p_rows": [{"scrap_id": sid, "trip_id": tid} for sid, tid in pairs],
    }).execute()


def _upsert_memberships(sb: Client, trip_id: str, scrap_ids: list[str]) -> None:
    """Add PLAN memberships for the given owned scraps to a trip (approved)."""
    _add_plan_memberships(sb, [(sid, trip_id) for sid in scrap_ids])


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
    into the trip as approved (scope is not enforced; the user chose them). The
    places stay on the Wander List."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    ids = [
        r["id"]
        for r in (
            sb.table("travelscrapbook_scraps")
            .select("id")
            .eq("user_id", user.user_id)
            .in_("id", body.scrap_ids)
            .execute()
        ).data or []
    ]
    if not ids:
        return ScrapListResponse(scraps=[])
    _upsert_memberships(sb, trip_id, ids)
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*, travelscrapbook_scraps(*)")
        .eq("trip_id", trip_id)
        .in_("scrap_id", ids)
        .is_("role", "null")
        .execute()
    ).data or []
    flat = membership_rows_to_scraps(rows)
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, flat, with_vibes=True)]
    )


# ── Membership assignment / staging ──────────────────────────────────────────

@router.post(
    "/scraps/{scrap_id}/assign",
    response_model=ScrapResponse,
    status_code=200,
    summary="Add a scrap to a trip",
)
async def assign_scrap(
    body: AssignRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Add an owned place to a trip as approved — the tap on a suggestion chip or
    a single trip pick. Additive: the place keeps any other trip memberships and
    stays on the Wander List."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    get_accessible_trip(sb, body.trip_id, user.user_id, need_write=True)
    _upsert_memberships(sb, body.trip_id, [scrap_id])
    return _hydrated_membership(sb, scrap_id, body.trip_id)


@router.put(
    "/scraps/{scrap_id}/trips",
    response_model=ScrapResponse,
    status_code=200,
    summary="Set exactly which trips a place is in",
)
async def set_scrap_trips(
    body: SetTripsRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Reconcile a place's trip memberships to the given set (the multi-select
    'Add to trips' picker). Adds new memberships (approved), removes dropped ones
    (their per-trip schedule + vibes cascade away). Every affected trip must be
    one the caller can write to. The place stays on the Wander List throughout."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    requested = set(body.trip_ids)
    # PLAN memberships only (role IS NULL, 020): the picker reconciles the
    # place's plan set — its checkpoint roles on trips are untouchable here.
    current = {
        m["trip_id"]
        for m in (
            sb.table("travelscrapbook_scrap_trips")
            .select("trip_id")
            .eq("scrap_id", scrap_id)
            .is_("role", "null")
            .execute()
        ).data or []
    }
    to_add = requested - current
    to_remove = current - requested
    assert_writable_trips(sb, to_add | to_remove, user.user_id)
    _add_plan_memberships(sb, [(scrap_id, tid) for tid in to_add])
    if to_remove:
        sb.table("travelscrapbook_scrap_trips").delete().eq(
            "scrap_id", scrap_id
        ).in_("trip_id", list(to_remove)).is_("role", "null").execute()
        # Removing via the multi-select is still resolving the suggestion — mark
        # each dropped trip so it doesn't re-suggest this place (migration 018).
        for tid in to_remove:
            _record_dismissals(sb, tid, [scrap_id])
    # Return the (Wander-List) scrap with its refreshed trip membership set.
    scrap = get_owned_scrap(sb, scrap_id, user.user_id)
    return ScrapResponse(**hydrate_scraps(sb, [scrap], with_trip_ids=True)[0])


@router.post(
    "/scraps/{scrap_id}/trips/{trip_id}/approve",
    response_model=ScrapResponse,
    status_code=200,
    summary="Approve a staged membership",
)
async def approve_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Confirm an auto-staged place into its trip (staged → approved)."""
    sb = get_supabase()
    membership, _ = get_accessible_membership(
        sb, scrap_id, trip_id, user.user_id, need_write=True
    )
    if membership["status"] != MembershipStatus.STAGED:
        raise HTTPException(status_code=409, detail="This place isn't staged on that trip")
    sb.table("travelscrapbook_scrap_trips").update(
        {"status": MembershipStatus.APPROVED}
    ).eq("id", membership["id"]).execute()
    return _hydrated_membership(sb, scrap_id, trip_id)


@router.delete(
    "/scraps/{scrap_id}/trips/{trip_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Remove a place from a trip",
)
async def unassign_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove a place from ONE trip (staging 'remove', or pulling an approved
    plan back out). The membership's route position, timeline slot, and vibes
    cascade away; the place stays on the Wander List and in any other trips."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    sb.table("travelscrapbook_scrap_trips").delete().eq(
        "scrap_id", scrap_id
    ).eq("trip_id", trip_id).is_("role", "null").execute()
    # The user resolved this suggestion — don't re-suggest it for this trip.
    _record_dismissals(sb, trip_id, [scrap_id])
    return MessageResponse(message="Removed from the trip")


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
    """One-tap review: every place the caller staged onto the trip becomes
    approved. Scoped to the caller's own scraps so one collaborator can't
    approve another's staged places."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    staged = (
        sb.table("travelscrapbook_scrap_trips")
        .select("id, travelscrapbook_scraps(user_id)")
        .eq("trip_id", trip_id)
        .eq("status", MembershipStatus.STAGED)
        .is_("role", "null")
        .execute()
    ).data or []
    mine = [
        m["id"] for m in staged
        if (m.get("travelscrapbook_scraps") or {}).get("user_id") == user.user_id
    ]
    if mine:
        sb.table("travelscrapbook_scrap_trips").update(
            {"status": MembershipStatus.APPROVED}
        ).in_("id", mine).execute()
    flat = membership_rows_to_scraps(_trip_memberships(sb, trip_id))
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, flat, with_vibes=True)]
    )
