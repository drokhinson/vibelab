"""First-paint bootstrap bundle.

Two calls, split by what the first screen actually needs.

GET /bootstrap is the blocking one — the FE waits on it only when it has no
cached identity to boot from. It returns:
  - current_user (raw profile row)
  - profile_bundle (stats, shelves, recent plays, status_map, buddies, requests)
  - feed_first_page + feed_cursor (composed in Python; reuses feed_service so
    Hot Games / Suggested Buddies interspersing is not duplicated)
  - recently_played_games (host flow game-picker seed)
  - play_partners (host flow player-picker seed: accounts + ghosts + recent,
    from one bgb_play_partners RPC)
  - bootstrap_version (int; FE wipes cache when this changes)

GET /bootstrap/game-bundles is the deferred one — one bgb_game_detail_bundle
per owned game. That's an N+1 in SQL (up to 250 invocations, ~5 statements
each) and nothing on the first screen reads it, so the FE pulls it from an idle
callback after the user has already landed. Game Detail falls back to its own
fetch on a miss, so a slow or failed warm-up degrades to the old behavior.

The FE writes each block straight into the appropriate cache namespace and runs
the entire app off that cache until SWR background-refresh kicks in.
"""

import asyncio
from typing import Any

from fastapi import Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import GameBundlesResponse
from .services import feed_service, game_service, played_with_service

# Cap on how many owned games get a prebuilt detail bundle. Mirrors the RPC's
# own default; the overflow is marked `truncated` and lazily fetched instead.
_MAX_GAME_BUNDLES = 250


@router.get(
    "/bootstrap",
    response_model=dict,
    status_code=200,
    summary="First-paint cache warm-up bundle",
)
async def get_bootstrap(
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Return everything the FE caches on initial load, minus the game bundles."""
    sb = get_supabase()
    viewer = user.user_id

    # Every block below is independent, but the Supabase client is synchronous,
    # so calling them inline would serialize the round trips *and* block the
    # event loop for every other in-flight request. to_thread + gather makes
    # the wall time the slowest single block instead of the sum — which is why
    # the buddies / ghosts / played-with trio was worth folding into one RPC
    # (migration 047): at five sequential queries it WAS the slowest block, so
    # it alone set this endpoint's floor.
    #
    # max_game_bundles=0 tells bgb_bootstrap to skip the per-owned-game N+1;
    # /bootstrap/game-bundles below serves that separately.
    (
        rpc_result,
        feed_page,
        recent_games,
        partners,
    ) = await asyncio.gather(
        asyncio.to_thread(
            lambda: sb.rpc(
                "bgb_bootstrap", {"viewer": viewer, "max_game_bundles": 0}
            ).execute()
        ),
        asyncio.to_thread(feed_service.build_feed_page, sb, viewer, cursor=None, limit=20),
        asyncio.to_thread(game_service.recently_played, sb, viewer, limit=6),
        asyncio.to_thread(played_with_service.fetch_play_partners, sb, viewer),
    )

    payload: dict[str, Any] = dict(rpc_result.data or {})
    payload["feed_first_page"] = feed_page.model_dump(mode="json")
    payload["feed_cursor"] = feed_page.next_cursor
    payload["recently_played_games"] = [g.model_dump(mode="json") for g in recent_games]
    payload["play_partners"] = partners.model_dump(mode="json")
    return payload


@router.get(
    "/bootstrap/game-bundles",
    response_model=GameBundlesResponse,
    status_code=200,
    summary="Deferred warm-up: detail bundles for every owned game",
)
async def get_bootstrap_game_bundles(
    user: CurrentUser = Depends(get_current_user),
) -> GameBundlesResponse:
    """Return one prebuilt game-detail bundle per owned game, keyed by game_id."""
    sb = get_supabase()
    result = await asyncio.to_thread(
        lambda: sb.rpc(
            "bgb_game_bundles",
            {"viewer": user.user_id, "max_bundles": _MAX_GAME_BUNDLES},
        ).execute()
    )
    data = dict(result.data or {})
    return GameBundlesResponse(
        game_detail_bundles=data.get("game_detail_bundles") or {},
        owned_count=data.get("owned_count") or 0,
        truncated=bool(data.get("truncated")),
    )
