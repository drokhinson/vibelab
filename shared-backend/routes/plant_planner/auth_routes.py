"""Auth routes: health + current user (Supabase Auth-backed)."""

from fastapi import Depends

from shared_models import HealthResponse
from . import router
from .dependencies import CurrentUser, get_current_user
from .models import MeResponse


@router.get("/health", response_model=HealthResponse, summary="Plant Planner health check")
async def health() -> dict:
    """Health check."""
    return {"project": "plant-planner", "status": "ok"}


@router.get("/auth/me", response_model=MeResponse, summary="Current user profile")
async def me(user: CurrentUser = Depends(get_current_user)) -> MeResponse:
    """Return the authenticated user's profile (auto-created on first sign-in)."""
    return MeResponse(
        user_id=user.user_id,
        display_name=user.display_name,
        is_admin=user.is_admin,
    )
