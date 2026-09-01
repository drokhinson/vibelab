"""Achievements — the Profile hub's nineteen-badge spoke.

Self-only, for the same reason the Stats detail endpoint is: the spoke hangs
off the Profile hub, which is the viewer's own screen, and "you have not linked
BGG yet" is not something a stranger should be able to pull about someone.
"""

from fastapi import Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import AchievementsResponse
from .services import achievement_service


@router.get(
    "/achievements",
    response_model=AchievementsResponse,
    status_code=200,
    summary="Every achievement, resolved against the caller's progress",
)
async def get_achievements(
    user: CurrentUser = Depends(get_current_user),
) -> AchievementsResponse:
    """Return the caller's badges, unlocking any that are newly earned."""
    return achievement_service.fetch_achievements(get_supabase(), user.user_id)


@router.post(
    "/achievements/installed",
    response_model=AchievementsResponse,
    status_code=200,
    summary="Record that the caller is running the installed web app",
)
async def mark_app_installed(
    user: CurrentUser = Depends(get_current_user),
) -> AchievementsResponse:
    """Stamp the install date — the one badge no query could ever derive.

    Fired by the web app the first time it observes itself running in
    standalone display-mode. Idempotent: the stamp is written only while the
    column is still NULL, so every later launch is a no-op that simply returns
    the current payload.
    """
    return achievement_service.mark_installed(get_supabase(), user.user_id)
