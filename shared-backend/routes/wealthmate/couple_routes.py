"""Couple management routes: get, create, invite, respond, list invites."""

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import get_current_user, _require_couple, _get_couple_id_for_user
from .models import InviteBody, InviteRespondBody
from .constants import InvitationStatus, InviteAction


@router.get("/couple")
async def get_couple(user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    couple = (
        sb.table("wealthmate_couples")
        .select("*")
        .eq("id", couple_id)
        .execute()
    )
    if not couple.data:
        raise HTTPException(status_code=404, detail="Couple not found")

    members = (
        sb.table("wealthmate_couple_members")
        .select("id, user_id, role, joined_at")
        .eq("couple_id", couple_id)
        .execute()
    )

    # Fetch user details for each member
    member_list = []
    for m in members.data or []:
        u = (
            sb.table("wealthmate_users")
            .select("id, username, display_name")
            .eq("id", m["user_id"])
            .execute()
        )
        member_info = {**m}
        if u.data:
            member_info["username"] = u.data[0]["username"]
            member_info["display_name"] = u.data[0]["display_name"]
        member_list.append(member_info)

    return {
        **couple.data[0],
        "members": member_list,
    }


@router.post("/couple")
async def create_couple(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    # Every user gets a household on registration; return existing one
    existing = _get_couple_id_for_user(user["user_id"])
    if existing:
        return {"couple_id": existing, "role": "owner"}

    # Fallback: create one if somehow missing (e.g. legacy users)
    couple_result = sb.table("wealthmate_couples").insert({}).execute()
    if not couple_result.data:
        raise HTTPException(status_code=500, detail="Failed to create couple")
    couple_id = couple_result.data[0]["id"]

    sb.table("wealthmate_couple_members").insert({
        "couple_id": couple_id,
        "user_id": user["user_id"],
        "role": "owner",
    }).execute()

    return {"couple_id": couple_id, "role": "owner"}


@router.post("/couple/invite")
async def send_invite(body: InviteBody, user: dict = Depends(get_current_user)):
    couple_id = _require_couple(user)
    sb = get_supabase()

    # Cannot invite yourself
    if body.to_username == user["username"]:
        raise HTTPException(status_code=400, detail="You cannot invite yourself")

    # Check if invitee exists
    invitee = (
        sb.table("wealthmate_users")
        .select("id")
        .eq("username", body.to_username)
        .execute()
    )
    if not invitee.data:
        raise HTTPException(status_code=404, detail=f"User '{body.to_username}' not found")

    # Check if invitee is already merged with someone else
    invitee_id = invitee.data[0]["id"]
    invitee_couple = _get_couple_id_for_user(invitee_id)
    if invitee_couple:
        members = (
            sb.table("wealthmate_couple_members")
            .select("id")
            .eq("couple_id", invitee_couple)
            .execute()
        )
        if len(members.data or []) > 1:
            raise HTTPException(status_code=400, detail="That user is already merged with someone else")

    # Check for existing pending invite
    existing = (
        sb.table("wealthmate_invitations")
        .select("id")
        .eq("couple_id", couple_id)
        .eq("to_username", body.to_username)
        .eq("status", InvitationStatus.PENDING)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=400, detail="A pending invite already exists for this user")

    result = sb.table("wealthmate_invitations").insert({
        "from_user_id": user["user_id"],
        "to_username": body.to_username,
        "couple_id": couple_id,
        "status": InvitationStatus.PENDING,
    }).execute()

    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create invitation")
    return result.data[0]


@router.post("/couple/invite/{invite_id}/respond")
async def respond_to_invite(invite_id: str, body: InviteRespondBody, user: dict = Depends(get_current_user)):
    # Pydantic validates action is a valid InviteAction enum value

    sb = get_supabase()
    # Fetch invite
    invite = (
        sb.table("wealthmate_invitations")
        .select("*")
        .eq("id", invite_id)
        .eq("status", InvitationStatus.PENDING)
        .execute()
    )
    if not invite.data:
        raise HTTPException(status_code=404, detail="Invite not found or already responded")

    inv = invite.data[0]
    # Verify invite is for the current user
    if inv["to_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="This invite is not for you")

    new_status = InvitationStatus.ACCEPTED if body.action == InviteAction.ACCEPT else InvitationStatus.DECLINED
    sb.table("wealthmate_invitations").update({"status": new_status}).eq("id", invite_id).execute()

    if body.action == InviteAction.ACCEPT:
        old_couple_id = _get_couple_id_for_user(user["user_id"])
        new_couple_id = inv["couple_id"]

        # Check user isn't already merged with someone else
        if old_couple_id and old_couple_id != new_couple_id:
            old_members = (
                sb.table("wealthmate_couple_members")
                .select("id")
                .eq("couple_id", old_couple_id)
                .execute()
            )
            if len(old_members.data or []) > 1:
                raise HTTPException(status_code=400, detail="You are already merged with someone else")

            # Merge: move all data from old solo household to new couple
            # Accounts
            sb.table("wealthmate_accounts").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Check-ins
            sb.table("wealthmate_checkins").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Expense groups
            sb.table("wealthmate_expense_groups").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Recurring expenses
            sb.table("wealthmate_recurring_expenses").update(
                {"couple_id": new_couple_id}
            ).eq("couple_id", old_couple_id).execute()

            # Remove old membership and delete old couple
            sb.table("wealthmate_couple_members").delete().eq(
                "couple_id", old_couple_id
            ).eq("user_id", user["user_id"]).execute()
            sb.table("wealthmate_couples").delete().eq("id", old_couple_id).execute()

        # Add user to the inviter's couple
        sb.table("wealthmate_couple_members").insert({
            "couple_id": new_couple_id,
            "user_id": user["user_id"],
            "role": "partner",
        }).execute()

    return {"status": new_status, "couple_id": inv["couple_id"] if body.action == InviteAction.ACCEPT else None}


@router.get("/couple/invites")
async def list_invites(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    # Invites sent TO this user
    result = (
        sb.table("wealthmate_invitations")
        .select("*")
        .eq("to_username", user["username"])
        .eq("status", InvitationStatus.PENDING)
        .order("created_at", desc=True)
        .execute()
    )
    invites = result.data or []

    # Enrich with sender info
    for inv in invites:
        sender = (
            sb.table("wealthmate_users")
            .select("username, display_name")
            .eq("id", inv["from_user_id"])
            .execute()
        )
        if sender.data:
            inv["from_username"] = sender.data[0]["username"]
            inv["from_display_name"] = sender.data[0]["display_name"]

    return invites
