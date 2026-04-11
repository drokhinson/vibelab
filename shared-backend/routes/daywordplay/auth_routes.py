"""
routes/daywordplay/auth_routes.py
Auth: profile upsert, me, delete account (Supabase Auth version).

Registration and login are handled client-side via Supabase JS.
The backend only manages app-specific profile data.
"""

from fastapi import Depends, HTTPException

from db import get_supabase
from shared_models import HealthResponse

from . import router
from .models import UpsertProfileBody
from .dependencies import get_current_user


@router.get("/health", response_model=HealthResponse, summary="Day Word Play health check")
async def health():
    """Health check."""
    return {"project": "daywordplay", "status": "ok"}


@router.post("/auth/profile")
async def upsert_profile(body: UpsertProfileBody, user: dict = Depends(get_current_user)):
    """Create or update user profile after Supabase Auth signup."""
    sb = get_supabase()
    username = body.username.strip().lower()

    if len(username) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters.")

    # Check username uniqueness (exclude current user)
    existing = (
        sb.table("daywordplay_profiles")
        .select("id")
        .eq("username", username)
        .neq("id", user["user_id"])
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken.")

    result = (
        sb.table("daywordplay_profiles")
        .upsert({
            "id": user["user_id"],
            "username": username,
            "display_name": body.display_name or username,
            "email": body.email or user.get("email"),
        })
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create profile")

    profile = result.data[0]
    return {
        "user": {
            "id": profile["id"],
            "username": profile["username"],
            "display_name": profile["display_name"],
        },
    }


@router.get("/auth/me")
async def me(current_user: dict = Depends(get_current_user)):
    """Get current user profile."""
    sb = get_supabase()
    result = (
        sb.table("daywordplay_profiles")
        .select("id, username, display_name, email, created_at")
        .eq("id", current_user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return result.data[0]


@router.delete("/auth/me")
async def delete_account(current_user: dict = Depends(get_current_user)):
    """Delete the current user account and all data."""
    from db import delete_auth_user
    delete_auth_user(current_user["user_id"])
    return {"deleted": True}
