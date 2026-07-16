"""The trip's day-by-day timeline."""

from fastapi import Depends, Path

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import TimelineResponse
from .services.hydrate import hydrate_scraps
from .services.timeline import build_timeline


@router.get(
    "/trips/{trip_id}/timeline",
    response_model=TimelineResponse,
    status_code=200,
    summary="Day-by-day trip timeline",
)
async def get_timeline(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TimelineResponse:
    """The trip's days with their markers (dated anchors: arrival, stay
    check-in/out, departure) and scheduled plans, plus unscheduled plans with
    a proximity-based slot suggestion. Readable by the owner and any member.
    Empty with reason=no_dates when nothing carries a date yet."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    anchors = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .execute()
    ).data or []
    scraps = hydrate_scraps(
        sb,
        (
            sb.table("travelscrapbook_scraps")
            .select("*")
            .eq("trip_id", trip_id)
            .eq("status", ScrapStatus.APPROVED)
            .execute()
        ).data or [],
        with_vibes=True,
    )
    return TimelineResponse(**build_timeline(trip, anchors, scraps))
