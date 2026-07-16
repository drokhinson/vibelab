"""Trip access control — owner-or-member gating shared across route modules.

A trip is reachable by its owner (travelscrapbook_trips.user_id) and by any user
with an *accepted* row in travelscrapbook_trip_members. Access resolves to a
role: OWNER > COLLABORATOR > VIEWER. Reads need any role; writes need
collaborator-or-owner; a few settings need owner.

This lives in its own module (not trip_routes) so scrap/source/route/export
routes can import it without importing trip_routes' route handlers.
"""

from typing import Any

from fastapi import HTTPException

from .constants import MemberStatus, TripMemberRole


def get_accessible_trip(
    sb,
    trip_id: str,
    user_id: str,
    *,
    need_write: bool = False,
    need_owner: bool = False,
) -> tuple[dict[str, Any], TripMemberRole]:
    """Return (trip_row, caller_role) for a trip the caller can access.

    404 when the trip is missing or the caller is neither owner nor an accepted
    member. 403 when ``need_owner`` and the caller isn't the owner, or
    ``need_write`` and the caller is a viewer.
    """
    rows = (
        sb.table("travelscrapbook_trips")
        .select("*")
        .eq("id", trip_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Trip not found")
    trip = rows.data[0]

    if trip["user_id"] == user_id:
        role = TripMemberRole.OWNER
    else:
        member = (
            sb.table("travelscrapbook_trip_members")
            .select("role, status")
            .eq("trip_id", trip_id)
            .eq("user_id", user_id)
            .eq("status", MemberStatus.ACCEPTED)
            .execute()
        ).data
        if not member:
            # Don't leak the trip's existence to non-members.
            raise HTTPException(status_code=404, detail="Trip not found")
        role = TripMemberRole(member[0]["role"])

    if need_owner and role != TripMemberRole.OWNER:
        raise HTTPException(status_code=403, detail="Only the trip owner can do that")
    if need_write and role == TripMemberRole.VIEWER:
        raise HTTPException(
            status_code=403, detail="Viewers can't change this trip — ask for collaborator access"
        )
    return trip, role


def get_accessible_scrap(sb, scrap_id: str, user_id: str) -> dict[str, Any]:
    """Fetch a scrap the caller can access via its trip (used by vibe endpoints
    so any traveler on a trip can rate any place on it). 404 if the scrap is
    missing, has no trip, or the caller can't access that trip."""
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("id", scrap_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Scrap not found")
    scrap = rows.data[0]
    if not scrap.get("trip_id"):
        raise HTTPException(status_code=400, detail="Add this place to a trip before setting a vibe")
    # Read access is enough to rate — raises 404 if the caller isn't on the trip.
    get_accessible_trip(sb, scrap["trip_id"], user_id)
    return scrap
