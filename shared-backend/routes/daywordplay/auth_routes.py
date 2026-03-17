"""
routes/daywordplay/auth_routes.py
Auth: register, login, me, delete account.
"""
from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException

from db import get_supabase
from auth import hash_password, verify_password, create_token

from . import router
from .models import RegisterBody, LoginBody
from .dependencies import get_current_user
from .constants import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRY_DAYS


def _make_token(user_id: str, username: str) -> str:
    payload = {
        "user_id": user_id,
        "username": username,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
    }
    return create_token(payload, JWT_SECRET, JWT_ALGORITHM)


@router.get("/health")
async def health():
    return {"project": "daywordplay", "status": "ok"}


@router.post("/auth/register")
async def register(body: RegisterBody):
    username = body.username.strip().lower()
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters.")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    sb = get_supabase()
    existing = sb.table("daywordplay_users").select("id").eq("username", username).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken.")

    pw_hash = hash_password(body.password)
    result = sb.table("daywordplay_users").insert({
        "username": username,
        "display_name": body.display_name or username,
        "email": body.email,
        "password_hash": pw_hash,
    }).execute()

    user = result.data[0]
    token = _make_token(user["id"], user["username"])
    return {"token": token, "user": {"id": user["id"], "username": user["username"], "display_name": user["display_name"]}}


@router.post("/auth/login")
async def login(body: LoginBody):
    username = body.username.strip().lower()
    sb = get_supabase()
    result = sb.table("daywordplay_users").select("id, username, display_name, password_hash").eq("username", username).execute()
    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    user = result.data[0]
    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = _make_token(user["id"], user["username"])
    return {"token": token, "user": {"id": user["id"], "username": user["username"], "display_name": user["display_name"]}}


@router.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = sb.table("daywordplay_users").select("id, username, display_name, email, created_at").eq("id", current_user["user_id"]).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found.")
    return result.data[0]


@router.delete("/auth/me")
async def delete_account(current_user: dict = Depends(get_current_user)):
    sb = get_supabase()
    user_id = current_user["user_id"]
    # Cascade handled by FK constraints; explicitly clean up group memberships
    sb.table("daywordplay_group_members").delete().eq("user_id", user_id).execute()
    sb.table("daywordplay_users").delete().eq("id", user_id).execute()
    return {"deleted": True}
