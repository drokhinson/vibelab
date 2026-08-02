"""Stop routes: admin create/update/delete/reorder. Reads come via the trip bundle."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException, Path

from auth import require_admin
from db import get_supabase
from shared_models import StatusResponse

from . import router
from .models import CreateStopBody, ReorderBody, StopResponse, UpdateStopBody


@router.post(
    "/trips/{trip_id}/stops",
    response_model=StopResponse,
    status_code=201,
    summary="Add a stop to a trip",
)
async def create_stop(
    body: CreateStopBody,
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> StopResponse:
    """Create a stop at the end of a trip's list. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    trip = sb.table("tripguide_trips").select("id").eq("id", trip_id).execute()
    if not trip.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Stop name cannot be empty")

    last = (
        sb.table("tripguide_stops")
        .select("sort_order")
        .eq("trip_id", trip_id)
        .order("sort_order", desc=True)
        .limit(1)
        .execute()
    )
    next_order = (last.data[0]["sort_order"] + 1) if last.data else 0

    result = sb.table("tripguide_stops").insert({
        "trip_id": trip_id,
        "name": name,
        "description": body.description,
        "content_html": body.content_html or "",
        "sort_order": next_order,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create stop")
    return StopResponse(**result.data[0])


@router.put("/stops/{stop_id}", response_model=StopResponse, status_code=200, summary="Update a stop")
async def update_stop(
    body: UpdateStopBody,
    stop_id: str = Path(..., description="Stop ID"),
    authorization: Optional[str] = Header(None),
) -> StopResponse:
    """Update a stop's name, description, content, or order. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("tripguide_stops").select("id").eq("id", stop_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Stop not found")

    update_data: dict = {}
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Stop name cannot be empty")
        update_data["name"] = name
    if body.description is not None:
        update_data["description"] = body.description
    if body.content_html is not None:
        update_data["content_html"] = body.content_html
    if body.sort_order is not None:
        update_data["sort_order"] = body.sort_order

    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        sb.table("tripguide_stops").update(update_data).eq("id", stop_id).execute()

    updated = sb.table("tripguide_stops").select("*").eq("id", stop_id).execute().data[0]
    return StopResponse(**updated)


@router.post(
    "/trips/{trip_id}/stops/reorder",
    response_model=StatusResponse,
    status_code=200,
    summary="Reorder a trip's stops",
)
async def reorder_stops(
    body: ReorderBody,
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> StatusResponse:
    """Set each stop's sort_order to its index in ordered_ids. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    trip = sb.table("tripguide_trips").select("id").eq("id", trip_id).execute()
    if not trip.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    now = datetime.now(timezone.utc).isoformat()
    for index, stop_id in enumerate(body.ordered_ids):
        (
            sb.table("tripguide_stops")
            .update({"sort_order": index, "updated_at": now})
            .eq("id", stop_id)
            .eq("trip_id", trip_id)
            .execute()
        )
    return StatusResponse(status="reordered")


@router.delete("/stops/{stop_id}", response_model=StatusResponse, status_code=200, summary="Delete a stop")
async def delete_stop(
    stop_id: str = Path(..., description="Stop ID"),
    authorization: Optional[str] = Header(None),
) -> StatusResponse:
    """Delete a stop. Admin only."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("tripguide_stops").select("id").eq("id", stop_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Stop not found")

    sb.table("tripguide_stops").delete().eq("id", stop_id).execute()
    return StatusResponse(status="deleted")
