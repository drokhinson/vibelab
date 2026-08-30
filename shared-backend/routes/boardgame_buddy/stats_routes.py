"""Per-user stats endpoints.

Two shapes, deliberately kept apart:
  - /users/{me,id}/stats        the small aggregate the Profile hub's stats
                                card and the profile bundle read.
  - /users/me/stats/detail      everything the Stats spoke draws, in one call.

The detail endpoint is self-only. The Stats spoke hangs off the Profile hub,
which is the viewer's own screen; the numbers it surfaces (an unplayed shelf,
a nemesis, a personal-best table) are the kind of thing a person is happy to
see about themselves and would not expect a stranger to be able to pull about
them. Profiles staying otherwise public is unaffected — /users/{id}/stats is
still open.
"""

from typing import Any

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
    "/users/me/stats/detail",
    response_model=dict,
    status_code=200,
    summary="Everything the Stats spoke draws, in one call",
)
async def get_my_stats_detail(
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Return the Stats screen's whole payload.

    Backed by the `bgb_user_stats_detail` RPC. Returned as a plain dict rather
    than a Pydantic model, matching GET /profile/bundle: the RPC is the shape's
    single source of truth, and a second declaration of eleven nested blocks in
    models.py would only be one more thing to drift.
    """
    return stats_service.fetch_stats_detail(get_supabase(), user.user_id)


@router.get(
    "/users/{user_id}/stats",
    response_model=StatsResponse,
    status_code=200,
    summary="Stats for any user (profiles are public)",
)
async def get_user_stats(
    user_id: str = Path(..., description="Target user UUID"),
    _viewer: CurrentUser = Depends(get_current_user),
) -> StatsResponse:
    """Profiles are fully public so this is unguarded beyond auth."""
    return stats_service.fetch_stats(get_supabase(), user_id)
