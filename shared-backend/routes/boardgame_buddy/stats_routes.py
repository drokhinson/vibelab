"""Per-user stats endpoints — feed the Profile view's Strava-style metric strip."""

from fastapi import Depends, Path

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import StatsResponse
from .services import stats_service


@router.get(
    "/users/me/stats",
    response_model=StatsResponse,
    status_code=200,
    summary="Stats for the current user",
)
async def get_my_stats(
    user: CurrentUser = Depends(get_current_user),
) -> StatsResponse:
    """Aggregate play stats for the current viewer."""
    return stats_service.fetch_stats(get_supabase(), user.user_id)


@router.get(
    "/users/{user_id}/stats",
    response_model=StatsResponse,
    status_code=200,
    summary="Stats for any user (profiles are public)",
)
async def get_user_stats(
    user_id: str = Path(..., description="Target user UUID"),
    viewer: CurrentUser = Depends(get_current_user),
) -> StatsResponse:
    """Profiles are fully public so this is unguarded beyond auth."""
    return stats_service.fetch_stats(get_supabase(), user_id)
