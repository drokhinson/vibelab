"""User profile endpoints."""

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
    PublicProfileResponse,
)
from .services import profile_service


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
    status_code=200,
    summary="Update display name on the current user's profile",
)
async def update_profile(
    body: ProfileCreate,
    user: CurrentUser = Depends(get_current_user),
) -> ProfileResponse:
    """Rename the current user. Username is locked in at signup — only
    display_name is mutable here."""
    sb = get_supabase()
    result = (
        sb.table("boardgamebuddy_profiles")
        .update({"display_name": body.display_name})
        .eq("id", user.user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
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
    """Find other BoardgameBuddy users by display name *or* username
    (case-insensitive substring match). Email shown for tiebreaking."""
    sb = get_supabase()
    # PostgREST `.or_()` takes a comma-joined list of column ops. Both
    # columns are matched with case-insensitive `like`; the lowercased
    # `username` column makes the lower-vs-upper distinction moot for
    # itself, but using `ilike` keeps the two predicates symmetrical.
    needle = q.replace(",", "").replace("(", "").replace(")", "")
    rows = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, username")
        .or_(f"display_name.ilike.%{needle}%,username.ilike.%{needle}%")
        .neq("id", user.user_id)
        .order("display_name")
        .limit(20)
        .execute()
    )
    return [
        ProfileSearchResult(
            id=row["id"],
            display_name=row["display_name"],
            username=row["username"],
        )
        for row in (rows.data or [])
    ]


@router.get(
    "/users/{user_id}/profile",
    response_model=PublicProfileResponse,
    status_code=200,
    summary="Get a user's public profile",
)
async def get_public_profile(
    user_id: str,
    viewer: CurrentUser = Depends(get_current_user),
) -> PublicProfileResponse:
    """Profiles are fully public — anyone signed in can see anyone else's profile."""
    return profile_service.fetch_public_profile(get_supabase(), viewer.user_id, user_id)


@router.delete(
    "/profile",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete the current user's account and data",
)
async def delete_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> MessageResponse:
    """Delete the current user's profile. Cascades to collections, plays, user_chapters, etc."""
    sb = get_supabase()
    # Deleting the profile cascades via ON DELETE CASCADE to collections, plays,
    # buddies, user_chapters, chapter_reports. Guide chapters the user authored
    # have created_by set to NULL (ON DELETE SET NULL).
    sb.table("boardgamebuddy_profiles").delete().eq("id", su_user.sub).execute()
    return MessageResponse(message="Account deleted")
