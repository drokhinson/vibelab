"""Discover endpoints — the tab that turns a shelf and a play history into
games worth looking at.

Thin adapter over services/discovery_service.py. One bundle, four rails:
  - personal picks (bgb_discover_recommendations, migration 038)
  - BGG's hot list, with catalog rows attached where we have them
  - this year's releases, by BGG rank
  - the viewer's own dormant shelf (bgb_dormant_collection)

The stats the picks and the new-releases rail rank by are backfilled by the
admin trio in game_routes.py (`/games/admin/*stats*`).
"""

from fastapi import Depends, Query

from db import get_supabase

from . import router
from .constants import AdminRunTool
from .dependencies import CurrentUser, get_admin_or_service_key, get_current_user
from .models import DiscoverBundleResponse, HotRefreshResult
from .services import admin_run_progress, discovery_service


@router.get(
    "/discover",
    response_model=DiscoverBundleResponse,
    status_code=200,
    summary="The Discover tab in one round trip",
)
async def get_discover(
    refresh: bool = Query(
        False,
        description="Bypass the ten-minute server cache. The client sends this "
                    "on the first mount after a collection or play write.",
    ),
    user: CurrentUser = Depends(get_current_user),
) -> DiscoverBundleResponse:
    """Personal picks, BGG's hot list, this year's releases and the viewer's dormant shelf."""
    return await discovery_service.build_bundle(
        get_supabase(),
        user.user_id,
        refresh=refresh,
    )


@router.post(
    "/discover/admin/refresh-trending",
    response_model=HotRefreshResult,
    status_code=200,
    summary="Snapshot BGG's hot list and import what the catalog lacks (admin or service key)",
)
async def refresh_trending(
    _caller: CurrentUser | None = Depends(get_admin_or_service_key),
) -> HotRefreshResult:
    """Write one run of the hot list (migration 039); the daily cron and the Settings admin row both call this.

    The ledger is opened BEFORE any work, and failed in both except arms, so a
    run that dies leaves a log saying where — the same shape `check_bgg` uses.
    It is keyed by the TOOL, not by the caller, which is what lets the cron's
    nightly run be readable in the morning: `_caller` is None for a service-key
    caller, so there is no user to key on and nobody to attribute it to beyond
    "Scheduled run".
    """
    # Inline rather than a BackgroundTask: the cron wants the counts back, and
    # ten throttled imports is well inside the platform timeout. Leaving the
    # page does not stop it — the browser's own request stays open, and the
    # ledger is readable from anywhere until it expires.
    with admin_run_progress.run_pass(
        AdminRunTool.TRENDING,
        started_by=_caller.display_name if _caller else None,
    ) as progress:
        return await discovery_service.refresh_hot_snapshot(
            get_supabase(), progress=progress
        )
