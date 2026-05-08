"""
routes/daywordplay/profile_routes.py
Health check + Supabase Auth-backed user profile endpoints.
"""
from fastapi import Depends, HTTPException

from auth import ADMIN_API_KEY
from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user
from shared_models import HealthResponse

from . import router
from .models import (
    AdminKeyBody,
    MessageResponse,
    ProfileCreate,
    ProfileResponse,
)


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=200,
    summary="Day Word Play health check",
)
async def health() -> HealthResponse:
    """Health check."""
    return HealthResponse(project="daywordplay", status="ok")


@router.get(
    "/profile",
    response_model=ProfileResponse,
    status_code=200,
    summary="Get current user profile",
)
async def get_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Return the current Supabase user's Day Word Play profile."""
    sb = get_supabase()
    result = (
        sb.table("daywordplay_profiles")
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
    """Upsert the current user's profile (display_name, avatar_url)."""
    sb = get_supabase()
    payload: dict = {"id": su_user.sub, "display_name": body.display_name}
    if body.avatar_url is not None:
        payload["avatar_url"] = body.avatar_url
    result = (
        sb.table("daywordplay_profiles")
        .upsert(payload, on_conflict="id")
        .execute()
    )
    return ProfileResponse(**result.data[0])


@router.post(
    "/profile/become-admin",
    response_model=ProfileResponse,
    status_code=200,
    summary="Promote current user to admin via shared admin key",
)
async def become_admin(
    body: AdminKeyBody,
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Exchange the shared ADMIN_API_KEY for the is_admin flag on this profile."""
    if body.admin_key != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")
    sb = get_supabase()
    result = (
        sb.table("daywordplay_profiles")
        .update({"is_admin": True})
        .eq("id", su_user.sub)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return ProfileResponse(**result.data[0])


@router.delete(
    "/profile",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete the current user's account",
)
async def delete_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> MessageResponse:
    """Delete the current user's profile. ON DELETE CASCADE removes group memberships, sentences, votes, bookmarks, etc."""
    sb = get_supabase()
    sb.table("daywordplay_profiles").delete().eq("id", su_user.sub).execute()
    return MessageResponse(message="Account deleted")
