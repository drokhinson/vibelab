"""Scrap reads, edits, staging review, and trip assignment.

Creation happens via POST /capture (source_routes) — one URL can fan out into
several scraps. A scrap is a saved place: inbox (no trip), staged (auto-matched
to a trip, awaiting review), or approved.
"""

from typing import Any

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .constants import GeocodeConfidence, ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    AssignManyRequest,
    AssignRequest,
    MessageResponse,
    PlanCreateRequest,
    ScrapListResponse,
    ScrapResponse,
    ScrapUpdateRequest,
    TripWishlistResponse,
    TripWishlistScrap,
)
from .services import nominatim
from .services.enrichment import (
    _geocode_with_fallback,
    _load_category_slugs,
    build_maps_url,
)
from .services.llm import PlaceExtraction
from .services.hydrate import hydrate_scraps
from .services.places import (
    find_or_create_place,
    normalize_place_name,
    place_matches_trip_scope,
    region_for_country_code,
)
from .trip_routes import get_owned_trip


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


def _hydrated_scrap(sb, scrap: dict[str, Any]) -> ScrapResponse:
    return ScrapResponse(**hydrate_scraps(sb, [scrap])[0])


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
    "/trips/{trip_id}/scraps",
    response_model=ScrapListResponse,
    status_code=200,
    summary="List a trip's scraps",
)
async def list_scraps(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """All scraps in a trip (approved and staged), newest first."""
    sb = get_supabase()
    get_owned_trip(sb, trip_id, user.user_id)
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("trip_id", trip_id)
        .order("created_at", desc=True)
        .execute()
    )
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, rows.data or [])]
    )


@router.get(
    "/visited",
    response_model=ScrapListResponse,
    status_code=200,
    summary="Places you've marked visited",
)
async def list_visited(
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """Every scrap the user marked visited (any trip or the wishlist),
    most-recently-visited first — the Visited view."""
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .not_.is_("visited_at", "null")
        .order("visited_at", desc=True)
        .execute()
    ).data or []
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, rows)]
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
    trip = get_owned_trip(sb, trip_id, user.user_id)
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
    trip = get_owned_trip(sb, trip_id, user.user_id)
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
    get_owned_trip(sb, trip_id, user.user_id)
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


@router.post(
    "/trips/{trip_id}/plans",
    response_model=ScrapResponse,
    status_code=201,
    summary="Manually add a plan to a trip by name",
)
async def create_plan(
    body: PlanCreateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Add a plan by typing a place name (no URL): geocode it, dedupe into a
    canonical place, and attach it to the trip as approved. Reuses an existing
    scrap for the same place if the user already has one."""
    sb = get_supabase()
    get_owned_trip(sb, trip_id, user.user_id)

    categories = _load_category_slugs(sb)
    category = body.category if body.category in categories else "other"
    extraction = PlaceExtraction(
        place_name=body.name, city=body.city, country=body.country,
        category=category, geocode_query=None, confident=True,
    )
    geo, confidence = await _geocode_with_fallback(extraction)
    maps_url = build_maps_url(body.name, body.city, body.country)
    place, _created = find_or_create_place(
        sb, user.user_id, extraction, geo, confidence, maps_url
    )

    existing = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("place_id", place["id"])
        .limit(1)
        .execute()
    ).data
    if existing:
        row = (
            sb.table("travelscrapbook_scraps")
            .update({
                "trip_id": trip_id,
                "status": ScrapStatus.APPROVED,
                "updated_at": "now()",
            })
            .eq("id", existing[0]["id"])
            .execute()
        ).data[0]
    else:
        row = (
            sb.table("travelscrapbook_scraps")
            .insert({
                "user_id": user.user_id,
                "place_id": place["id"],
                "trip_id": trip_id,
                "status": ScrapStatus.APPROVED,
                "notes": body.notes,
            })
            .execute()
        ).data[0]
    return _hydrated_scrap(sb, row)


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
    """Edit place fields, category, notes, or favorite flag. Place edits write
    to the scrap's canonical place row (safe — places are per-user). Pass
    regeocode=true to re-run Nominatim on the (possibly edited) place."""
    sb = get_supabase()
    existing = get_owned_scrap(sb, scrap_id, user.user_id)
    place = (
        sb.table("travelscrapbook_places")
        .select("*")
        .eq("id", existing["place_id"])
        .execute()
    ).data[0]

    update = body.model_dump(exclude_unset=True, exclude={"regeocode"})

    scrap_update = {k: update[k] for k in ("notes", "is_favorite") if k in update}
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
    suggestion chip or the manual trip picker."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    get_owned_trip(sb, body.trip_id, user.user_id)
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
    scrap back out); it returns to the inbox."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({
            "trip_id": None,
            "status": ScrapStatus.INBOX,
            "route_position": None,
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
    """One-tap review: every staged scrap in the trip becomes approved."""
    sb = get_supabase()
    get_owned_trip(sb, trip_id, user.user_id)
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({"status": ScrapStatus.APPROVED, "updated_at": "now()"})
        .eq("trip_id", trip_id)
        .eq("status", ScrapStatus.STAGED)
        .execute()
    )
    return ScrapListResponse(
        scraps=[ScrapResponse(**s) for s in hydrate_scraps(sb, updated.data or [])]
    )


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
