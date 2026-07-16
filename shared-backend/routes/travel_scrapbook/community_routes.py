"""Community place pool: browse everyone's places, save one as your own."""

from fastapi import Depends, HTTPException, Path, Query

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    CommunityPlacesResponse,
    CommunitySaveRequest,
    ScrapResponse,
)
from .scrap_routes import _hydrated_scrap
from .services.community import aggregate_places, copy_place_for_user


@router.get(
    "/community/places",
    response_model=CommunityPlacesResponse,
    status_code=200,
    summary="Browse the community place pool",
)
async def list_community_places(
    q: str | None = Query(None, max_length=120, description="Search name or city"),
    country: str | None = Query(None, max_length=120, description="Filter by country name"),
    category: str | None = Query(None, max_length=40, description="Filter by category slug"),
    limit: int = Query(60, ge=1, le=200, description="Max aggregated places"),
    user: CurrentUser = Depends(get_current_user),
) -> CommunityPlacesResponse:
    """Places any traveler has scrapped, aggregated across users (geocoded
    only), most-saved first. Only canonical facts are shared — names, pins,
    categories, save counts, and public source URLs; never notes, ratings,
    or who saved what."""
    sb = get_supabase()
    return CommunityPlacesResponse(
        places=aggregate_places(sb, q=q, country=country, category=category, limit=limit)
    )


@router.post(
    "/community/places/{place_id}/save",
    response_model=ScrapResponse,
    status_code=201,
    summary="Save a community place as your own",
)
async def save_community_place(
    body: CommunitySaveRequest,
    place_id: str = Path(..., description="Community place UUID (ref_place_id)"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Copy a community place's canonical fields into your own places (no
    re-geocode) and scrap it — onto a trip you can write to when trip_id is
    given, else onto your Wander List. Sources are NOT copied; they stay with
    whoever captured them. Reuses your existing scrap for the same place."""
    sb = get_supabase()
    if body.trip_id:
        get_accessible_trip(sb, body.trip_id, user.user_id, need_write=True)

    ref_rows = (
        sb.table("travelscrapbook_places")
        .select("*")
        .eq("id", place_id)
        .execute()
    ).data
    if not ref_rows:
        raise HTTPException(status_code=404, detail="Place not found")
    place = copy_place_for_user(sb, user.user_id, ref_rows[0])

    existing = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("user_id", user.user_id)
        .eq("place_id", place["id"])
        .limit(1)
        .execute()
    ).data
    fields = {
        "trip_id": body.trip_id,
        "status": ScrapStatus.APPROVED if body.trip_id else ScrapStatus.INBOX,
    }
    if existing:
        row = (
            sb.table("travelscrapbook_scraps")
            .update({**fields, "updated_at": "now()"})
            .eq("id", existing[0]["id"])
            .execute()
        ).data[0]
    else:
        row = (
            sb.table("travelscrapbook_scraps")
            .insert({"user_id": user.user_id, "place_id": place["id"], **fields})
            .execute()
        ).data[0]
    return _hydrated_scrap(sb, row)
