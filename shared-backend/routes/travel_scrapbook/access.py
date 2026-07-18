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


def assert_writable_trips(sb, trip_ids: set[str] | list[str], user_id: str) -> None:
    """Batch write-access check over several trips (max two queries, however
    many trips) — the anti-N+1 form of calling get_accessible_trip in a loop.
    404 when any trip is missing or invisible to the caller; 403 when the
    caller is only a viewer on any of them."""
    ids = list(set(trip_ids))
    if not ids:
        return
    trips = (
        sb.table("travelscrapbook_trips")
        .select("id, user_id")
        .in_("id", ids)
        .execute()
    ).data or []
    found = {t["id"]: t for t in trips}
    if len(found) < len(ids):
        raise HTTPException(status_code=404, detail="Trip not found")
    not_owned = [tid for tid, t in found.items() if t["user_id"] != user_id]
    if not not_owned:
        return
    roles = {
        m["trip_id"]: TripMemberRole(m["role"])
        for m in (
            sb.table("travelscrapbook_trip_members")
            .select("trip_id, role")
            .in_("trip_id", not_owned)
            .eq("user_id", user_id)
            .eq("status", MemberStatus.ACCEPTED)
            .execute()
        ).data or []
    }
    for tid in not_owned:
        role = roles.get(tid)
        if role is None:
            # Don't leak the trip's existence to non-members.
            raise HTTPException(status_code=404, detail="Trip not found")
        if role == TripMemberRole.VIEWER:
            raise HTTPException(
                status_code=403,
                detail="Viewers can't change this trip — ask for collaborator access",
            )


def get_accessible_membership(
    sb, scrap_id: str, trip_id: str, user_id: str, *, need_write: bool = False
) -> tuple[dict[str, Any], TripMemberRole]:
    """Return (membership_row, caller_role) for a place's PLAN membership on a
    trip the caller can access. 404 if the place isn't a plan on that trip or
    the trip isn't accessible. Used by the per-trip vibe / schedule / approve
    endpoints — those act on plans only, so checkpoint memberships (role set,
    020) are invisible here."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*")
        .eq("scrap_id", scrap_id)
        .eq("trip_id", trip_id)
        .is_("role", "null")
        .execute()
    ).data
    if not rows:
        raise HTTPException(status_code=404, detail="This place isn't on that trip")
    _, role = get_accessible_trip(sb, trip_id, user_id, need_write=need_write)
    return rows[0], role
