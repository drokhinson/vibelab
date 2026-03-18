"""Auth routes: register, login, reset-password, recovery-code, me, delete account."""

import secrets

from fastapi import Depends, HTTPException

from auth import hash_password, verify_password
from db import get_supabase
from . import router
from .dependencies import get_current_user, create_app_token
from .models import RegisterBody, LoginBody, ResetPasswordBody


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {"project": "spotme", "status": "ok"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.post("/auth/register")
async def register(body: RegisterBody):
    sb = get_supabase()
    existing = (
        sb.table("spotme_users")
        .select("id")
        .eq("username", body.username)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken")

    password_hash = hash_password(body.password)
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash = hash_password(recovery_code)
    user_data = {
        "username": body.username,
        "display_name": body.display_name or body.username,
        "password_hash": password_hash,
        "recovery_hash": recovery_hash,
    }
    if body.email:
        user_data["email"] = body.email
    result = sb.table("spotme_users").insert(user_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create user")

    user = result.data[0]
    token = create_app_token(user["id"], user["username"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
        },
        "recovery_code": recovery_code,
    }


@router.post("/auth/login")
async def login(body: LoginBody):
    sb = get_supabase()
    result = (
        sb.table("spotme_users")
        .select("*")
        .eq("username", body.username)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user = result.data[0]
    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = create_app_token(user["id"], user["username"])
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "bio": user.get("bio"),
            "home_label": user.get("home_label"),
            "is_discoverable": user.get("is_discoverable", False),
        },
    }


@router.post("/auth/reset-password")
async def reset_password(body: ResetPasswordBody):
    sb = get_supabase()
    result = (
        sb.table("spotme_users")
        .select("id, recovery_hash")
        .eq("username", body.username)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=400, detail="Invalid username or recovery code")
    user = result.data[0]
    if not user.get("recovery_hash"):
        raise HTTPException(status_code=400, detail="No recovery code set for this account")
    if not verify_password(body.recovery_code, user["recovery_hash"]):
        raise HTTPException(status_code=400, detail="Invalid username or recovery code")

    new_password_hash = hash_password(body.new_password)
    new_recovery_code = secrets.token_urlsafe(16)
    new_recovery_hash = hash_password(new_recovery_code)
    sb.table("spotme_users").update({
        "password_hash": new_password_hash,
        "recovery_hash": new_recovery_hash,
    }).eq("id", user["id"]).execute()

    return {"message": "Password reset successful", "new_recovery_code": new_recovery_code}


@router.post("/auth/recovery-code")
async def generate_recovery_code(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    recovery_code = secrets.token_urlsafe(16)
    recovery_hash = hash_password(recovery_code)
    sb.table("spotme_users").update({
        "recovery_hash": recovery_hash,
    }).eq("id", user["user_id"]).execute()
    return {"recovery_code": recovery_code}


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("spotme_users")
        .select("id, username, display_name, email, bio, avatar_url, is_discoverable, home_lat, home_lng, home_label, traveling_to_lat, traveling_to_lng, traveling_to_label, traveling_from, traveling_until, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return result.data[0]


@router.delete("/auth/me")
async def delete_account(user: dict = Depends(get_current_user)):
    """Delete the current user and all associated data."""
    sb = get_supabase()
    user_id = user["user_id"]
    sb.table("spotme_user_hobbies").delete().eq("user_id", user_id).execute()
    sb.table("spotme_users").delete().eq("id", user_id).execute()
    return {"status": "deleted"}
