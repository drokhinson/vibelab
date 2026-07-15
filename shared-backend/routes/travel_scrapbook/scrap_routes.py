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
    AssignRequest,
    MessageResponse,
    ScrapListResponse,
    ScrapResponse,
    ScrapUpdateRequest,
)
from .services import nominatim
from .services.enrichment import build_maps_url
from .services.hydrate import hydrate_scraps
from .services.places import normalize_place_name
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
