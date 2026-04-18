"""Profile + health routes. Authentication itself is handled by Supabase Auth."""

from fastapi import Depends, HTTPException

from db import get_supabase
from jwt_auth import SupabaseUser, get_current_supabase_user
from shared_models import HealthResponse

from . import router
from .models import ProfileBody, ProfileResponse


@router.get("/health", response_model=HealthResponse, status_code=200, summary="Plant Planner health check")
async def health() -> HealthResponse:
    """Health check."""
    return HealthResponse(project="plant-planner", status="ok")


@router.get("/profile", response_model=ProfileResponse, status_code=200, summary="Get current user's profile")
async def get_profile(
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Return the PlantPlanner profile for the authenticated Supabase user."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_profiles")
        .select("id, display_name, created_at")
        .eq("id", su_user.sub)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not set up")
    row = result.data[0]
    return ProfileResponse(
        id=row["id"],
        display_name=row["display_name"],
        created_at=str(row["created_at"]),
    )


@router.post("/profile", response_model=ProfileResponse, status_code=201, summary="Create or update profile")
async def upsert_profile(
    body: ProfileBody,
    su_user: SupabaseUser = Depends(get_current_supabase_user),
) -> ProfileResponse:
    """Create the profile on first login, or update the display name later."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_profiles")
        .upsert(
            {"id": su_user.sub, "display_name": body.display_name},
            on_conflict="id",
        )
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save profile")
    row = result.data[0]
    return ProfileResponse(
        id=row["id"],
        display_name=row["display_name"],
        created_at=str(row["created_at"]),
    )
