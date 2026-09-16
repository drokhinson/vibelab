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
from .dependencies import CurrentUser, get_current_user
from .models import DiscoverBundleResponse
from .services import discovery_service


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
