"""First-paint bootstrap bundle.

Two calls, split by what the first screen actually needs.

GET /bootstrap is the blocking one — the FE waits on it only when it has no
cached identity to boot from. It returns:
  - current_user (raw profile row)
  - profile_bundle (stats, shelves, recent plays, status_map, buddies, requests)
  - feed_first_page + feed_cursor (composed in Python; reuses feed_service so
    Hot Games / Suggested Buddies interspersing is not duplicated)
  - recently_played_games (host flow game-picker seed)
  - play_partners (host flow player-picker seed: accounts + pending buddy
    requests + ghosts + recent, from one bgb_play_partners RPC)
  - notifications_first_page (the bell's first page AND its unread count, from
    one notification_service.list_notifications call)
  - release_notices_unseen (the what's-new popup's slides, oldest-first, capped;
    empty for almost every boot)
  - ranks + rank_queue (the viewer's game ranking and the played games still
    unranked; null when that read failed — see _soft)
  - bootstrap_version (int; FE wipes cache when this changes)

GET /bootstrap/game-bundles is the deferred one — one bgb_game_detail_bundle
per owned game. That's an N+1 in SQL (up to 250 invocations, ~5 statements
each) and nothing on the first screen reads it, so the FE pulls it from an idle
callback after the user has already landed. Game Detail falls back to its own
fetch on a miss, so a slow or failed warm-up degrades to a per-page fetch.

The FE writes each block straight into the appropriate cache namespace and runs
the entire app off that cache until SWR background-refresh kicks in.
"""

import asyncio
import logging
from typing import Any

from fastapi import Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import GameBundlesResponse
from .services import (
    feed_service,
    game_service,
    notification_service,
    played_with_service,
    rank_service,
    release_notice_service,
)

logger = logging.getLogger(__name__)

# Cap on how many owned games get a prebuilt detail bundle. Mirrors the RPC's
# own default; the overflow is marked `truncated` and lazily fetched instead.
_MAX_GAME_BUNDLES = 250

# Notifications warmed into the first page. Must match the PAGE constant in
# views/notifications-view.js: the frontend keys this entry as page one and
# pages on from its cursor, so a different size here would make the first scroll
# either re-fetch rows it already has or skip past them.
_NOTIFICATIONS_PAGE = 20


async def _soft(label: str, fn, *args):
    """Run a decoration read in a worker thread; a failure is None, not a 500.

    For blocks the first screen can live without: the ranking decorates
    Collection and the game page, which fetch it themselves on a miss, so it
    must never be the reason the app fails to boot.
    """
    try:
        return await asyncio.to_thread(fn, *args)
    except Exception:  # noqa: BLE001 — logged, and the FE refetches on a miss
        logger.exception("bootstrap: %s failed", label)
        return None


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
    # the buddies / ghosts / played-with trio is one RPC (bgb_play_partners): as
    # five sequential queries it would be the slowest block, and alone set this
    # endpoint's floor.
    #
    # max_game_bundles=0 tells bgb_bootstrap to skip the per-owned-game N+1;
    # /bootstrap/game-bundles below serves that separately.
    # The notifications block rides this gather rather than bgb_profile_bundle
    # (where ghost_claims_incoming lives) for one reason: that function is 542
    # lines, and adding to it means re-emitting all 542 in a migration and
    # keeping a second copy of the body from drifting. Here it costs one more
    # parallel call, and the gather's wall time is its slowest member.
    #
    # It fetches the whole first PAGE, not just the unread integer. The count
    # alone would light the bell's dot and then leave the screen behind the dot
    # to fetch itself from scratch on first open — a cold round trip on the one
    # screen the user was just told had something waiting. The page costs
    # nothing extra here: list_notifications runs its two reads concurrently and
    # the unread count is one of them, so this member's wall time is what the
    # count alone already cost. `notifications_unread` is still emitted below
    # because an older frontend reads that key and nothing else.
    #
    # release_notices_unseen rides this gather for the same reason the
    # notifications block does — bgb_bootstrap is 542 lines and adding to it
    # means re-emitting all 542 in a migration. It is one indexed read against
    # a table with tens of rows, and it returns empty on almost every boot, so
    # it can never be this gather's slowest member. It is the popup's ONLY
    # delivery path: /bootstrap runs on every visit (the warm frontend boot
    # paints from cache and still calls it in the background), so a dedicated
    # endpoint would be a round trip bought for nothing.
    (
        rpc_result,
        feed_page,
        recent_games,
        partners,
        notifs,
        release_notices,
        ranks,
        rank_queue,
    ) = await asyncio.gather(
        asyncio.to_thread(
            lambda: sb.rpc(
                "bgb_bootstrap", {"viewer": viewer, "max_game_bundles": 0}
            ).execute()
        ),
        # Already a coroutine that gathers its own three blocks in worker
        # threads, so it joins this gather directly rather than being wrapped —
        # same shape as list_notifications below.
        feed_service.build_feed_page(sb, viewer, cursor=None, limit=20),
        asyncio.to_thread(game_service.recently_played, sb, viewer, limit=6),
        asyncio.to_thread(played_with_service.fetch_play_partners, sb, viewer),
        notification_service.list_notifications(sb, viewer, limit=_NOTIFICATIONS_PAGE),
        asyncio.to_thread(release_notice_service.unseen, sb, viewer),
        # The ranking rides here so Collection's chips and banner and the game
        # page's pill paint from cache on the first visit after sign-in, not a
        # round trip later. The queue (bgb_play_stats) is the heavier of the
        # two, and in parallel it still only costs whatever it exceeds the
        # slowest member by. Both are _soft: a failure boots without them.
        _soft("ranks", rank_service.list_ranks, sb, viewer),
        _soft("rank queue", rank_service.queue, sb, viewer),
    )

    payload: dict[str, Any] = dict(rpc_result.data or {})
    payload["feed_first_page"] = feed_page.model_dump(mode="json")
    payload["feed_cursor"] = feed_page.next_cursor
    payload["recently_played_games"] = [g.model_dump(mode="json") for g in recent_games]
    payload["play_partners"] = partners.model_dump(mode="json")
    payload["notifications_first_page"] = notifs.model_dump(mode="json")
    payload["notifications_unread"] = notifs.unread
    payload["release_notices_unseen"] = [
        n.model_dump(mode="json") for n in release_notices
    ]
    payload["ranks"] = None if ranks is None else [e.model_dump(mode="json") for e in ranks]
    payload["rank_queue"] = (
        None if rank_queue is None else [i.model_dump(mode="json") for i in rank_queue]
    )
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
