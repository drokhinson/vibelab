"""Auth routes: register, login, me, health."""

from fastapi import Depends, HTTPException

from auth import hash_password, verify_password
from db import get_supabase
from . import router
from .dependencies import get_current_user, create_app_token
from .models import RegisterBody, LoginBody


@router.get("/health")
async def health():
    return {"project": "plant-planner", "status": "ok"}


@router.post("/auth/register")
async def register(body: RegisterBody):
    sb = get_supabase()
    existing = (
        sb.table("plantplanner_users")
        .select("id")
        .eq("username", body.username)
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken")

    password_hash = hash_password(body.password)
    user_data = {
        "username": body.username,
        "display_name": body.display_name or body.username,
        "password_hash": password_hash,
    }
    result = sb.table("plantplanner_users").insert(user_data).execute()
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
    }


@router.post("/auth/login")
async def login(body: LoginBody):
    sb = get_supabase()
    result = (
        sb.table("plantplanner_users")
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
        },
    }


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    sb = get_supabase()
    result = (
        sb.table("plantplanner_users")
        .select("id, username, display_name, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return result.data[0]
