"""Auth routes: register, login, reset-password, recovery-code, me, email, delete account."""

import secrets

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import (
    get_current_user, _require_couple,
    _hash_password, _verify_password, _create_token, _get_couple_id_for_user,
)
from .models import RegisterBody, LoginBody, ResetPasswordBody, UpdateEmailBody


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {"project": "wealthmate", "status": "ok"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.post("/auth/register")
async def register(body: RegisterBody):
    sb = get_supabase()
    # Check username uniqueness
    existing = (
        sb.table("wealthmate_users")
        .select("id")
        .eq("username", body.username)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken")

    password_hash = _hash_password(body.password)
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash = _hash_password(recovery_code)
    user_data = {
        "username": body.username,
        "display_name": body.display_name or body.username,
        "password_hash": password_hash,
        "recovery_hash": recovery_hash,
    }
    if body.email:
        user_data["email"] = body.email
    result = sb.table("wealthmate_users").insert(user_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create user")

    user = result.data[0]

    # Auto-create a solo household so the user can start immediately
    couple_result = sb.table("wealthmate_couples").insert({}).execute()
    couple_id = couple_result.data[0]["id"] if couple_result.data else None
    if couple_id:
        sb.table("wealthmate_couple_members").insert({
            "couple_id": couple_id,
            "user_id": user["id"],
            "role": "owner",
        }).execute()

    token = _create_token(user["id"], user["username"], couple_id)
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "couple_id": couple_id,
        },
        "recovery_code": recovery_code,
    }


@router.post("/auth/login")
async def login(body: LoginBody):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("*")
        .eq("username", body.username)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user = result.data[0]

    # Dev convenience: allow dummy accounts to login with "password"
    is_dummy = body.username in ("adam", "eve") and body.password == "password"
    if not is_dummy:
        if not _verify_password(body.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password")

    couple_id = _get_couple_id_for_user(user["id"])
    token = _create_token(user["id"], user["username"], couple_id)
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "couple_id": couple_id,
        },
    }


@router.post("/auth/reset-password")
async def reset_password(body: ResetPasswordBody):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("id, recovery_hash")
        .eq("username", body.username)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=400, detail="Invalid username or recovery code")
    user = result.data[0]
    if not user.get("recovery_hash"):
        raise HTTPException(status_code=400, detail="No recovery code set for this account")
    if not _verify_password(body.recovery_code, user["recovery_hash"]):
        raise HTTPException(status_code=400, detail="Invalid username or recovery code")

    # Update password and rotate recovery code
    new_password_hash = _hash_password(body.new_password)
    new_recovery_code = secrets.token_urlsafe(16)
    new_recovery_hash = _hash_password(new_recovery_code)
    sb.table("wealthmate_users").update({
        "password_hash": new_password_hash,
        "recovery_hash": new_recovery_hash,
    }).eq("id", user["id"]).execute()

    return {"message": "Password reset successful", "new_recovery_code": new_recovery_code}


@router.post("/auth/recovery-code")
async def generate_recovery_code(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash = _hash_password(recovery_code)
    sb.table("wealthmate_users").update({
        "recovery_hash": recovery_hash,
    }).eq("id", user["user_id"]).execute()
    return {"recovery_code": recovery_code}


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("wealthmate_users")
        .select("id, username, display_name, email, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    u = result.data[0]
    u["couple_id"] = user["couple_id"]
    return u


@router.put("/auth/email")
async def update_email(body: UpdateEmailBody, user: dict = Depends(get_current_user)):
    sb = get_supabase()
    sb.table("wealthmate_users").update({
        "email": body.email,
    }).eq("id", user["user_id"]).execute()
    return {"message": "Email updated", "email": body.email}


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
            # Get checkin IDs to delete values
            checkins = (
                sb.table("wealthmate_checkins")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            checkin_ids = [c["id"] for c in (checkins.data or [])]
            if checkin_ids:
                sb.table("wealthmate_checkin_values").delete().in_("checkin_id", checkin_ids).execute()

            # Get account IDs to delete loan details
            accts = (
                sb.table("wealthmate_accounts")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            acct_ids = [a["id"] for a in (accts.data or [])]
            if acct_ids:
                sb.table("wealthmate_account_loan_details").delete().in_("account_id", acct_ids).execute()

            # Delete expense items via groups
            groups = (
                sb.table("wealthmate_expense_groups")
                .select("id")
                .eq("couple_id", couple_id)
                .execute()
            )
            group_ids = [g["id"] for g in (groups.data or [])]
            if group_ids:
                sb.table("wealthmate_expense_items").delete().in_("group_id", group_ids).execute()

            # Delete top-level couple data
            sb.table("wealthmate_checkins").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_accounts").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_expense_groups").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_recurring_expenses").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_invitations").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couple_members").delete().eq("couple_id", couple_id).execute()
            sb.table("wealthmate_couples").delete().eq("id", couple_id).execute()
        else:
            # Merged household — remove user from couple, reassign their personal accounts to partner
            sb.table("wealthmate_couple_members").delete().eq("user_id", user_id).execute()
            # Set personal accounts owned by this user to no owner (become joint)
            sb.table("wealthmate_accounts").update(
                {"owner_user_id": None}
            ).eq("couple_id", couple_id).eq("owner_user_id", user_id).execute()

    # Delete invitations sent by or to this user
    sb.table("wealthmate_invitations").delete().eq("from_user_id", user_id).execute()
    sb.table("wealthmate_invitations").delete().eq("to_username", user["username"]).execute()

    # Delete the user
    sb.table("wealthmate_users").delete().eq("id", user_id).execute()

    return {"status": "deleted"}
