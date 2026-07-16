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


def get_accessible_membership(
    sb, scrap_id: str, trip_id: str, user_id: str, *, need_write: bool = False
) -> tuple[dict[str, Any], TripMemberRole]:
    """Return (membership_row, caller_role) for a place's membership on a trip
    the caller can access. 404 if the place isn't on that trip or the trip isn't
    accessible. Used by the per-trip vibe / schedule endpoints so any traveler on
    a trip can weigh in on any place on it (read access is enough to set a vibe)."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*")
        .eq("scrap_id", scrap_id)
        .eq("trip_id", trip_id)
        .execute()
    ).data
    if not rows:
        raise HTTPException(status_code=404, detail="This place isn't on that trip")
    _, role = get_accessible_trip(sb, trip_id, user_id, need_write=need_write)
    return rows[0], role
