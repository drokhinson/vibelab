"""Trip routes: public list/read (bundle), admin create/update/delete."""

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Header, HTTPException, Path
from supabase import Client

from auth import require_admin
from db import get_supabase
from shared_models import StatusResponse

from . import router
from .models import (
    CreateTripBody,
    StopResponse,
    TripBundleResponse,
    TripResponse,
    UpdateTripBody,
)


def _validate_scheme(sb: Client, slug: str) -> None:
    """Raise 400 if the color-scheme slug does not exist."""
    res = sb.table("tripguide_color_schemes").select("slug").eq("slug", slug).execute()
    if not res.data:
        raise HTTPException(status_code=400, detail=f"Unknown color scheme: {slug}")


def _palette_for(sb: Client, slug: str) -> dict:
    """Fetch a color scheme's palette, falling back to an empty dict."""
    res = sb.table("tripguide_color_schemes").select("palette").eq("slug", slug).execute()
    return (res.data[0]["palette"] if res.data else {}) or {}


@router.get("/trips", response_model=List[TripResponse], status_code=200, summary="List trips")
async def list_trips() -> List[TripResponse]:
    """List all trips (with stop counts), ordered for display. No auth."""
    sb = get_supabase()
    trips = (
        sb.table("tripguide_trips")
        .select("*")
        .order("sort_order")
        .order("created_at")
        .execute()
    ).data or []

    # Stop counts in one query (avoid N+1).
    counts: dict[str, int] = {}
    if trips:
        stops = sb.table("tripguide_stops").select("trip_id").execute().data or []
        for s in stops:
            counts[s["trip_id"]] = counts.get(s["trip_id"], 0) + 1

    return [TripResponse(**t, stop_count=counts.get(t["id"], 0)) for t in trips]


@router.get(
    "/trips/{trip_id}",
    response_model=TripBundleResponse,
    status_code=200,
    summary="Get a trip with its stops",
)
async def get_trip(trip_id: str = Path(..., description="Trip ID")) -> TripBundleResponse:
    """Return a trip, its resolved color palette, and its ordered stops. No auth."""
    sb = get_supabase()
    trip_res = sb.table("tripguide_trips").select("*").eq("id", trip_id).execute()
    if not trip_res.data:
        raise HTTPException(status_code=404, detail="Trip not found")
    trip = trip_res.data[0]

    stops = (
        sb.table("tripguide_stops")
        .select("*")
        .eq("trip_id", trip_id)
        .order("sort_order")
        .order("created_at")
        .execute()
    ).data or []

    return TripBundleResponse(
        **trip,
        palette=_palette_for(sb, trip["color_scheme"]),
        stops=[StopResponse(**s) for s in stops],
    )


@router.post("/trips", response_model=TripResponse, status_code=201, summary="Create a trip")
async def create_trip(
    body: CreateTripBody,
    authorization: Optional[str] = Header(None),
) -> TripResponse:
    """Create a new trip. Admin only."""
    require_admin(authorization)
    sb = get_supabase()
    _validate_scheme(sb, body.color_scheme)

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Trip name cannot be empty")

    # New trips go to the end of the list.
    existing = sb.table("tripguide_trips").select("sort_order").order("sort_order", desc=True).limit(1).execute()
    next_order = (existing.data[0]["sort_order"] + 1) if existing.data else 0

    result = sb.table("tripguide_trips").insert({
        "name": name,
        "description": body.description,
        "color_scheme": body.color_scheme,
        "sort_order": next_order,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create trip")
    return TripResponse(**result.data[0], stop_count=0)


@router.put("/trips/{trip_id}", response_model=TripResponse, status_code=200, summary="Update a trip")
async def update_trip(
    body: UpdateTripBody,
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> TripResponse:
    """Update a trip's name, description, color scheme, or order. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("tripguide_trips").select("id").eq("id", trip_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    update_data: dict = {}
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Trip name cannot be empty")
        update_data["name"] = name
    if body.description is not None:
        update_data["description"] = body.description
    if body.color_scheme is not None:
        _validate_scheme(sb, body.color_scheme)
        update_data["color_scheme"] = body.color_scheme
    if body.sort_order is not None:
        update_data["sort_order"] = body.sort_order

    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        sb.table("tripguide_trips").update(update_data).eq("id", trip_id).execute()

    updated = sb.table("tripguide_trips").select("*").eq("id", trip_id).execute().data[0]
    count_res = sb.table("tripguide_stops").select("id").eq("trip_id", trip_id).execute()
    return TripResponse(**updated, stop_count=len(count_res.data or []))


@router.delete("/trips/{trip_id}", response_model=StatusResponse, status_code=200, summary="Delete a trip")
async def delete_trip(
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> StatusResponse:
    """Delete a trip and all its stops (cascade). Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("tripguide_trips").select("id").eq("id", trip_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    sb.table("tripguide_trips").delete().eq("id", trip_id).execute()
    return StatusResponse(status="deleted")
