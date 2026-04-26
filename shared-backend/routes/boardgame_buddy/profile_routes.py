"""User profile endpoints."""

from typing import Optional

from fastapi import Depends, HTTPException, Query

from auth import ADMIN_API_KEY
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    AdminKeyBody,
    MessageResponse,
    ProfileCreate,
    ProfileResponse,
    ProfileSearchResult,
)


@router.get(
    "/profile",
    response_model=ProfileResponse,
    status_code=200,
    summary="Get current user profile",
)
async def get_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Get the current user's profile."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_profiles")
        .select("*")
        .eq("id", su_user.sub)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return ProfileResponse(**result.data[0])


@router.post(
    "/profile",
    response_model=ProfileResponse,
    status_code=201,
    summary="Create or update profile",
)
async def create_or_update_profile(
    body: ProfileCreate,
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Create or update the current user's profile."""
    sb = get_supabase()

    result = (
        sb.table("boardgamebuddy_profiles")
        .upsert({
            "id": su_user.sub,
            "display_name": body.display_name,
        }, on_conflict="id")
        .execute()
    )
    return ProfileResponse(**result.data[0])


@router.post(
    "/profile/become-admin",
    response_model=ProfileResponse,
    status_code=200,
    summary="Promote current user to admin by admin key",
)
async def become_admin(
    body: AdminKeyBody,
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Exchange the shared admin API key for the is_admin flag on this user's profile."""
    if body.admin_key != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_profiles")
        .update({"is_admin": True})
        .eq("id", su_user.sub)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return ProfileResponse(**result.data[0])


@router.get(
    "/profiles/search",
    response_model=list[ProfileSearchResult],
    status_code=200,
    summary="Search profiles by display name (for buddy linking)",
)
async def search_profiles(
    q: str = Query(..., min_length=1, max_length=50, description="Display name fragment"),
    user: CurrentUser = Depends(get_current_user),
) -> list[ProfileSearchResult]:
    """Find other BoardgameBuddy users by display name. Email shown for tiebreaking."""
    sb = get_supabase()
    rows = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name")
        .ilike("display_name", f"%{q}%")
        .neq("id", user.user_id)
        .order("display_name")
        .limit(20)
        .execute()
    )
    out: list[ProfileSearchResult] = []
    for row in rows.data or []:
        email: Optional[str] = None
        try:
            au = sb.auth.admin.get_user_by_id(row["id"])
            email = getattr(au.user, "email", None) if au else None
        except Exception:
            email = None
        out.append(ProfileSearchResult(
            id=row["id"],
            display_name=row["display_name"],
            email=email,
        ))
    return out


@router.delete(
    "/profile",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete the current user's account and data",
)
async def delete_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> MessageResponse:
    """Delete the current user's profile. Cascades to collections, plays, chunks they authored (set null), etc."""
    sb = get_supabase()
    # Deleting the profile cascades via ON DELETE CASCADE to collections, plays,
    # buddies, pending guides, guide selections. Guide chunks the user authored
    # have created_by set to NULL (ON DELETE SET NULL).
    sb.table("boardgamebuddy_profiles").delete().eq("id", su_user.sub).execute()
    return MessageResponse(message="Account deleted")
