"""User profile endpoints."""

from fastapi import Depends, HTTPException

from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user

from . import router
from .models import ProfileCreate, ProfileResponse


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
