"""Trip sharing — invite/accept members and manage their roles.

The owner (travelscrapbook_trips.user_id) invites others by username as a
viewer or collaborator; each invite starts pending and only grants access once
accepted. Mirrors the wealthmate invite-by-username flow, keyed per trip.
"""

from typing import Any

from fastapi import Depends, HTTPException, Path

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import InviteAction, MemberStatus, TripMemberRole
from .dependencies import CurrentUser, get_current_user
from .models import (
    InvitationResponse,
    InvitationsResponse,
    InviteRespondRequest,
    MemberInviteRequest,
    MemberRoleUpdateRequest,
    MessageResponse,
    TripMemberResponse,
    TripMembersResponse,
)


def _lookup_profile_by_username(sb, username: str) -> dict[str, Any] | None:
    rows = (
        sb.table("travelscrapbook_profiles")
        .select("id, username, display_name")
        .eq("username", username)
        .limit(1)
        .execute()
    ).data
    return rows[0] if rows else None


def _profiles_by_id(sb, user_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not user_ids:
        return {}
    return {
        p["id"]: p
        for p in (
            sb.table("travelscrapbook_profiles")
            .select("id, username, display_name")
            .in_("id", sorted(set(user_ids)))
            .execute()
        ).data or []
    }


@router.get(
    "/trips/{trip_id}/members",
    response_model=TripMembersResponse,
    status_code=200,
    summary="List a trip's members",
)
async def list_members(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TripMembersResponse:
    """Owner (first) plus every member row, pending invites included. Visible to
    anyone on the trip."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    rows = (
        sb.table("travelscrapbook_trip_members")
        .select("user_id, role, status")
        .eq("trip_id", trip_id)
        .execute()
    ).data or []

    profiles = _profiles_by_id(sb, [trip["user_id"], *[r["user_id"] for r in rows]])
    owner = profiles.get(trip["user_id"], {})
    members = [
        TripMemberResponse(
            user_id=trip["user_id"],
            username=owner.get("username", ""),
            display_name=owner.get("display_name", "Owner"),
            role=TripMemberRole.OWNER,
            status=MemberStatus.ACCEPTED,
        )
    ]
    for r in rows:
        p = profiles.get(r["user_id"], {})
        members.append(TripMemberResponse(
            user_id=r["user_id"],
            username=p.get("username", ""),
            display_name=p.get("display_name", "Traveler"),
            role=TripMemberRole(r["role"]),
            status=MemberStatus(r["status"]),
        ))
    return TripMembersResponse(members=members)


@router.post(
    "/trips/{trip_id}/members",
    response_model=TripMemberResponse,
    status_code=201,
    summary="Invite a member to a trip",
)
async def invite_member(
    body: MemberInviteRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TripMemberResponse:
    """Invite a user (by username) as a viewer or collaborator. Owner only. The
    invite is pending until the invitee accepts it."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_owner=True)

    if body.username == user.username:
        raise HTTPException(status_code=400, detail="You already own this trip")

    invitee = _lookup_profile_by_username(sb, body.username)
    if not invitee:
        raise HTTPException(
            status_code=404,
            detail=f"No traveler named '{body.username}' — they need to sign in once first",
        )

    existing = (
        sb.table("travelscrapbook_trip_members")
        .select("id, status")
        .eq("trip_id", trip_id)
        .eq("user_id", invitee["id"])
        .execute()
    ).data
    if existing:
        row = existing[0]
        if row["status"] == MemberStatus.DECLINED:
            # Re-invite a previously declined user: reopen the same row.
            sb.table("travelscrapbook_trip_members").update({
                "role": body.role,
                "status": MemberStatus.PENDING,
                "invited_by": user.user_id,
                "responded_at": None,
            }).eq("id", row["id"]).execute()
        else:
            raise HTTPException(
                status_code=409,
                detail="That traveler is already invited — change their role instead",
            )
    else:
        sb.table("travelscrapbook_trip_members").insert({
            "trip_id": trip_id,
            "user_id": invitee["id"],
            "role": body.role,
            "status": MemberStatus.PENDING,
            "invited_by": user.user_id,
        }).execute()

    return TripMemberResponse(
        user_id=invitee["id"],
        username=invitee["username"],
        display_name=invitee["display_name"],
        role=body.role,
        status=MemberStatus.PENDING,
    )


@router.patch(
    "/trips/{trip_id}/members/{member_user_id}",
    response_model=TripMemberResponse,
    status_code=200,
    summary="Change a member's role",
)
async def update_member_role(
    body: MemberRoleUpdateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    member_user_id: str = Path(..., description="Member's user UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TripMemberResponse:
    """Promote a viewer to collaborator (or the reverse). Owner only."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_owner=True)

    existing = (
        sb.table("travelscrapbook_trip_members")
        .select("id, status")
        .eq("trip_id", trip_id)
        .eq("user_id", member_user_id)
        .execute()
    ).data
    if not existing:
        raise HTTPException(status_code=404, detail="Member not found")
    sb.table("travelscrapbook_trip_members").update(
        {"role": body.role}
    ).eq("id", existing[0]["id"]).execute()

    profile = _profiles_by_id(sb, [member_user_id]).get(member_user_id, {})
    return TripMemberResponse(
        user_id=member_user_id,
        username=profile.get("username", ""),
        display_name=profile.get("display_name", "Traveler"),
        role=body.role,
        status=MemberStatus(existing[0]["status"]),
    )


@router.delete(
    "/trips/{trip_id}/members/{member_user_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Remove a member or leave a trip",
)
async def remove_member(
    trip_id: str = Path(..., description="Trip UUID"),
    member_user_id: str = Path(..., description="Member's user UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove a member (owner) or leave a trip yourself (member). The departing
    member's saved places stay on the trip; they just lose access."""
    sb = get_supabase()
    trip_rows = (
        sb.table("travelscrapbook_trips")
        .select("user_id")
        .eq("id", trip_id)
        .execute()
    ).data
    if not trip_rows:
        raise HTTPException(status_code=404, detail="Trip not found")
    is_owner = trip_rows[0]["user_id"] == user.user_id
    if not is_owner and member_user_id != user.user_id:
        raise HTTPException(status_code=403, detail="Only the owner can remove other members")

    sb.table("travelscrapbook_trip_members").delete().eq(
        "trip_id", trip_id
    ).eq("user_id", member_user_id).execute()
    return MessageResponse(message="Left the trip" if not is_owner else "Member removed")


@router.get(
    "/invitations",
    response_model=InvitationsResponse,
    status_code=200,
    summary="My pending trip invitations",
)
async def list_invitations(
    user: CurrentUser = Depends(get_current_user),
) -> InvitationsResponse:
    """Trips the current user has been invited to but hasn't accepted yet."""
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_trip_members")
        .select("trip_id, role, invited_by, created_at, "
                "travelscrapbook_trips(name, cover_icon, user_id)")
        .eq("user_id", user.user_id)
        .eq("status", MemberStatus.PENDING)
        .order("created_at", desc=True)
        .execute()
    ).data or []

    inviter_ids = [r["invited_by"] for r in rows if r.get("invited_by")]
    owner_ids = [
        (r.get("travelscrapbook_trips") or {}).get("user_id")
        for r in rows
    ]
    names = _profiles_by_id(sb, [*inviter_ids, *[o for o in owner_ids if o]])

    invitations = []
    for r in rows:
        trip = r.get("travelscrapbook_trips") or {}
        owner_id = trip.get("user_id")
        invitations.append(InvitationResponse(
            trip_id=r["trip_id"],
            trip_name=trip.get("name", "Trip"),
            cover_icon=trip.get("cover_icon", "plane"),
            role=TripMemberRole(r["role"]),
            owner_display_name=(names.get(owner_id) or {}).get("display_name") if owner_id else None,
            invited_by_display_name=(names.get(r["invited_by"]) or {}).get("display_name")
                if r.get("invited_by") else None,
            created_at=r["created_at"],
        ))
    return InvitationsResponse(invitations=invitations)


@router.post(
    "/trips/{trip_id}/invitation/respond",
    response_model=MessageResponse,
    status_code=200,
    summary="Accept or decline a trip invitation",
)
async def respond_invitation(
    body: InviteRespondRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Accept or decline your own pending invitation to a trip."""
    sb = get_supabase()
    existing = (
        sb.table("travelscrapbook_trip_members")
        .select("id, status")
        .eq("trip_id", trip_id)
        .eq("user_id", user.user_id)
        .eq("status", MemberStatus.PENDING)
        .execute()
    ).data
    if not existing:
        raise HTTPException(status_code=404, detail="No pending invitation for this trip")

    new_status = (
        MemberStatus.ACCEPTED if body.action == InviteAction.ACCEPT else MemberStatus.DECLINED
    )
    sb.table("travelscrapbook_trip_members").update(
        {"status": new_status, "responded_at": "now()"}
    ).eq("id", existing[0]["id"]).execute()
    return MessageResponse(
        message="Joined the trip" if new_status == MemberStatus.ACCEPTED else "Invitation declined"
    )
