"""Stop routes for the personal page: public HTML fetch + admin-gated CRUD/reorder."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException, Path

from auth import require_admin
from db import get_supabase

from . import router
from .models import (
    CreateStopBody,
    MessageResponse,
    ReorderStopsBody,
    StopContentResponse,
    StopSummaryResponse,
    UpdateStopBody,
)

_STOP_COLS = "id, trip_id, title, meta, note, sort_order"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get(
    "/stops/{stop_id}",
    response_model=StopContentResponse,
    status_code=200,
    summary="Get a stop's full HTML page",
)
async def get_stop(
    stop_id: str = Path(..., description="Stop ID"),
) -> dict:
    """Public: the full html_content for one stop — hit once per popup open."""
    sb = get_supabase()
    result = (
        sb.table("person_trip_stops")
        .select("id, title, html_content")
        .eq("id", stop_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Stop not found")
    return result.data[0]


@router.post(
    "/admin/trips/{trip_id}/stops",
    response_model=StopSummaryResponse,
    status_code=201,
    summary="Add a stop to a trip",
)
async def create_stop(
    body: CreateStopBody,
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> dict:
    """Admin: append a stop to a trip. sort_order defaults to the current max + 1."""
    require_admin(authorization)
    sb = get_supabase()

    trip = sb.table("person_trips").select("id").eq("id", trip_id).execute()
    if not trip.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    if body.sort_order is not None:
        sort_order = body.sort_order
    else:
        existing = (
            sb.table("person_trip_stops")
            .select("sort_order")
            .eq("trip_id", trip_id)
            .order("sort_order", desc=True)
            .limit(1)
            .execute()
        )
        sort_order = (existing.data[0]["sort_order"] + 1) if existing.data else 0

    stop_data = {
        "trip_id": trip_id,
        "title": body.title,
        "meta": body.meta,
        "note": body.note,
        "html_content": body.html_content,
        "sort_order": sort_order,
    }
    result = sb.table("person_trip_stops").insert(stop_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create stop")
    row = result.data[0]
    # Return the summary shape (drop html_content from the echo).
    return {k: row[k] for k in ("id", "trip_id", "title", "meta", "note", "sort_order")}


@router.put(
    "/admin/stops/{stop_id}",
    response_model=StopSummaryResponse,
    status_code=200,
    summary="Update a stop",
)
async def update_stop(
    body: UpdateStopBody,
    stop_id: str = Path(..., description="Stop ID"),
    authorization: Optional[str] = Header(None),
) -> dict:
    """Admin: update a stop's fields (including html_content). Non-null only."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("person_trip_stops").select("id").eq("id", stop_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Stop not found")

    update_data: dict = {}
    for field in ["title", "meta", "note", "html_content", "sort_order"]:
        val = getattr(body, field)
        if val is not None:
            update_data[field] = val

    if update_data:
        update_data["updated_at"] = _now()
        result = sb.table("person_trip_stops").update(update_data).eq("id", stop_id).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update stop")

    updated = sb.table("person_trip_stops").select(_STOP_COLS).eq("id", stop_id).execute()
    return updated.data[0]


@router.delete(
    "/admin/stops/{stop_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a stop",
)
async def delete_stop(
    stop_id: str = Path(..., description="Stop ID"),
    authorization: Optional[str] = Header(None),
) -> MessageResponse:
    """Admin: delete a single stop."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("person_trip_stops").select("id").eq("id", stop_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Stop not found")

    sb.table("person_trip_stops").delete().eq("id", stop_id).execute()
    return MessageResponse(status="deleted", id=stop_id)


@router.post(
    "/admin/trips/{trip_id}/stops/reorder",
    response_model=MessageResponse,
    status_code=200,
    summary="Reorder a trip's stops",
)
async def reorder_stops(
    body: ReorderStopsBody,
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> MessageResponse:
    """Admin: set each stop's sort_order to its index in stop_ids."""
    require_admin(authorization)
    sb = get_supabase()

    owned = (
        sb.table("person_trip_stops")
        .select("id")
        .eq("trip_id", trip_id)
        .execute()
    )
    owned_ids = {row["id"] for row in (owned.data or [])}
    if set(body.stop_ids) != owned_ids:
        raise HTTPException(
            status_code=400,
            detail="stop_ids must contain exactly this trip's stops",
        )

    now = _now()
    for index, stop_id in enumerate(body.stop_ids):
        sb.table("person_trip_stops").update(
            {"sort_order": index, "updated_at": now}
        ).eq("id", stop_id).execute()

    return MessageResponse(status="reordered", id=trip_id)
