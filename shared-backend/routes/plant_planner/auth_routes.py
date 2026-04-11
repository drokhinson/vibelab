"""Auth routes: profile upsert, me, health (Supabase Auth version).

Registration and login are handled client-side via Supabase JS.
The backend only manages app-specific profile data.
"""

from fastapi import Depends, HTTPException

from db import get_supabase
from shared_models import HealthResponse
from . import router
from .dependencies import get_current_user
from .models import UpsertProfileBody


@router.get("/health", response_model=HealthResponse, summary="Plant Planner health check")
async def health():
    """Health check."""
    return {"project": "plant-planner", "status": "ok"}


@router.post("/auth/profile")
async def upsert_profile(body: UpsertProfileBody, user: dict = Depends(get_current_user)):
    """Create or update user profile after Supabase Auth signup."""
    sb = get_supabase()

    # Check username uniqueness (exclude current user)
    existing = (
        sb.table("plantplanner_profiles")
        .select("id")
        .eq("username", body.username)
        .neq("id", user["user_id"])
        .execute()
    )
    if existing.data:
        raise HTTPException(status_code=409, detail="Username already taken")

    result = (
        sb.table("plantplanner_profiles")
        .upsert({
            "id": user["user_id"],
            "username": body.username,
            "display_name": body.display_name or body.username,
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
async def me(user: dict = Depends(get_current_user)):
    """Get current user profile."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_profiles")
        .select("id, username, display_name, created_at")
        .eq("id", user["user_id"])
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data[0]


@router.delete("/auth/me")
async def delete_account(user: dict = Depends(get_current_user)):
    """Delete the current user account and all data."""
    from db import delete_auth_user
    delete_auth_user(user["user_id"])
    return {"status": "deleted"}
