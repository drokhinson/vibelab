"""The trip's day-by-day timeline."""

from fastapi import Depends, Path

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import MembershipStatus
from .dependencies import CurrentUser, get_current_user
from .models import TimelineResponse
from .services.checkpoints import load_trip_anchors
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps
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
    anchors = load_trip_anchors(sb, trip_id)
    scraps = hydrate_scraps(
        sb,
        membership_rows_to_scraps(
            (
                sb.table("travelscrapbook_scrap_trips")
                .select("*, travelscrapbook_scraps(*)")
                .eq("trip_id", trip_id)
                .eq("status", MembershipStatus.APPROVED)
                .is_("role", "null")   # plans only; checkpoints arrive as markers (020)
                .execute()
            ).data or []
        ),
        with_vibes=True,
    )
    return TimelineResponse(**build_timeline(trip, anchors, scraps))
