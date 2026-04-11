"""Auth routes: profile upsert, me, delete account."""

from fastapi import Depends, HTTPException

from db import get_supabase, delete_auth_user
from shared_models import HealthResponse
from . import router
from .dependencies import get_current_user, _require_couple, _get_couple_id_for_user
from .models import UpsertProfileBody


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health", response_model=HealthResponse, summary="WealthMate health check")
async def health():
    """Health check."""
    return {"project": "wealthmate", "status": "ok"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.post("/auth/profile")
async def upsert_profile(body: UpsertProfileBody, user: dict = Depends(get_current_user)):
    """Create or update user profile after Supabase Auth signup."""
    sb = get_supabase()
    user_id = user["user_id"]

    # Check username uniqueness (exclude self)
    existing = (
        sb.table("wealthmate_profiles")
        .select("id")
        .eq("username", body.username)
        .neq("id", user_id)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken")

    profile_data = {
        "id": user_id,
        "username": body.username,
        "display_name": body.display_name or body.username,
        "email": body.email or user.get("email"),
    }
    sb.table("wealthmate_profiles").upsert(profile_data).execute()

    # Auto-create household if this is a new profile
    couple_id = _get_couple_id_for_user(user_id)
    if not couple_id:
        couple_result = sb.table("wealthmate_couples").insert({}).execute()
        if couple_result.data:
            couple_id = couple_result.data[0]["id"]
            sb.table("wealthmate_couple_members").insert({
                "couple_id": couple_id,
                "user_id": user_id,
                "role": "owner",
            }).execute()

    return {
        "user": {
            "id": user_id,
            "username": body.username,
            "display_name": body.display_name or body.username,
            "couple_id": couple_id,
        }
    }


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    """Get current user profile."""
    sb = get_supabase()
    result = (
        sb.table("wealthmate_profiles")
        .select("id, username, display_name, email, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    u = result.data[0]
    u["couple_id"] = user["couple_id"]
    return u


# ---------------------------------------------------------------------------
# Account Deletion
# ---------------------------------------------------------------------------

@router.delete("/auth/me")
async def delete_account(user: dict = Depends(get_current_user)):
    """Delete the current user and all associated data."""
    sb = get_supabase()
    user_id = user["user_id"]
    couple_id = user.get("couple_id")

    if couple_id:
        # Check if user is the only member of their household
        members = (
            sb.table("wealthmate_couple_members")
            .select("id, user_id")
            .eq("couple_id", couple_id)
            .execute()
        )
        member_ids = [m["user_id"] for m in (members.data or [])]
        is_solo = len(member_ids) <= 1

        if is_solo:
            # Solo household — delete everything
            checkins = (
                sb.table("wealthmate_checkins")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            checkin_ids = [c["id"] for c in (checkins.data or [])]
            if checkin_ids:
                sb.table("wealthmate_checkin_values").delete().in_("checkin_id", checkin_ids).execute()

            accts = (
                sb.table("wealthmate_accounts")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            acct_ids = [a["id"] for a in (accts.data or [])]
            if acct_ids:
                sb.table("wealthmate_account_loan_details").delete().in_("account_id", acct_ids).execute()

            groups = (
                sb.table("wealthmate_expense_groups")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            group_ids = [g["id"] for g in (groups.data or [])]
            if group_ids:
                sb.table("wealthmate_expense_items").delete().in_("group_id", group_ids).execute()

            sb.table("wealthmate_checkins").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_accounts").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_expense_groups").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_recurring_expenses").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_invitations").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couple_members").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couples").delete().eq("id", couple_id).execute()
        else:
            # Merged household — remove user from couple, reassign their personal accounts
            sb.table("wealthmate_couple_members").delete().eq("user_id", user_id).execute()
            sb.table("wealthmate_accounts").update(
                {"owner_user_id": None}
            ).eq("couple_id", couple_id).eq("owner_user_id", user_id).execute()

    # Delete invitations sent by or to this user
    sb.table("wealthmate_invitations").delete().eq("from_user_id", user_id).execute()
    sb.table("wealthmate_invitations").delete().eq("to_username", user["username"]).execute()

    # Delete from Supabase Auth — ON DELETE CASCADE handles profile
    delete_auth_user(user_id)

    return {"status": "deleted"}
