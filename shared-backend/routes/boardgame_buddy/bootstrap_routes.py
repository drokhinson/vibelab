"""First-paint bootstrap bundle.

One round trip after auth that returns everything the FE caches:
  - current_user (raw profile row)
  - profile_bundle (stats, shelves, recent plays, status_map, buddies, requests)
  - game_detail_bundles (object keyed by game_id — one bundle per owned game)
  - feed_first_page + feed_cursor (composed in Python; reuses feed_service so
    Hot Games / Suggested Buddies / Featured-From-Collection interspersing is
    not duplicated)
  - recently_played_games (host flow game-picker seed)
  - play_partners (host flow player-picker seed: accounts + ghosts + recent)
  - bootstrap_version (int; FE wipes cache when this changes)

The FE writes each block straight into the appropriate cache namespace and
runs the entire app off that cache until SWR background-refresh kicks in.
"""

from typing import Any

from fastapi import Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .services import buddy_service, feed_service, game_service, played_with_service


@router.get(
    "/bootstrap",
    response_model=dict,
    status_code=200,
    summary="First-paint cache warm-up bundle",
)
async def get_bootstrap(
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Return everything the FE caches on initial load in one round trip."""
    sb = get_supabase()
    rpc_result = sb.rpc("bgb_bootstrap", {"viewer": user.user_id}).execute()
    payload: dict[str, Any] = dict(rpc_result.data or {})

    # Compose the feed first page in Python so the Hot Games / Suggested
    # Buddies / Featured-From-Collection rules stay in one place.
    feed_page = feed_service.build_feed_page(sb, user.user_id, cursor=None, limit=20)
    payload["feed_first_page"] = feed_page.model_dump(mode="json")
    payload["feed_cursor"] = feed_page.next_cursor

    # Host-flow seeds: recently-played games + the player-picker's combined
    # buddies/ghosts/recent bundle. Both lists only mutate when the user
    # finalizes a play; the FE re-warms after save.
    payload["recently_played_games"] = [
        g.model_dump(mode="json") for g in game_service.recently_played(sb, user.user_id, limit=6)
    ]
    payload["play_partners"] = {
        "accounts": [b.model_dump(mode="json") for b in buddy_service.list_accepted_buddies(sb, user.user_id)],
        "ghosts": [g.model_dump(mode="json") for g in played_with_service.fetch_ghost_players(sb, user.user_id)],
        "recent": [p.model_dump(mode="json") for p in played_with_service.fetch_played_with(sb, user.user_id)],
    }

    return payload
