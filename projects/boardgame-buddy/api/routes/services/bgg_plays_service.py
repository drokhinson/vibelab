"""Building the importer's BoardGameGeek preview: read, filter, resolve.

The BGG source of the play importer asks one question — *which of my
BoardGameGeek plays are not in BgB yet?* — and this answers it without writing
a single play. Everything that lands does so later, through the wizard's review
and POST /plays/import, which is the whole point of the move.

Three steps, and the order matters:

  1. READ. Prefer what a sync has just parked (bgg_plays_cache), because the
     usual way in here is the done screen's "Import N plays" button and walking
     BGG's paginated /plays a second time would make the user wait twice for
     one read. Falls back to reading BGG.
  2. FILTER, ALWAYS LIVE. The cached thing is the raw BGG read; "already in
     BgB" is asked of the database on every call. A cached filter would offer
     the user plays they imported thirty seconds ago.
  3. RESOLVE. Attach the catalog row for each BGG game id. Games the catalog
     has never seen come back as `game: None` and are the importer's Games step
     to fetch, on demand — nothing is queued here, so a user pays BGG's budget
     only for the games whose plays they are actually bringing over.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from supabase import Client

from ..bgg_client import BggWarmUpError
from ..bgg_plays_read import existing_bgg_play_ids, fetch_all_plays
from ..constants import MAX_BGG_PENDING_PLAYS
from ..models import (
    BggPendingPlay,
    BggPendingPlayer,
    BggPendingPlaysResponse,
    GameSummary,
)
from . import bgg_plays_cache

logger = logging.getLogger(__name__)


def _match_key(name: str) -> str:
    """Same normalisation play_import_service uses, for the same reason."""
    return " ".join(str(name or "").split()).lower()


def _distinct_player_names(plays: list[dict]) -> list[str]:
    """Every seat name across the preview, deduped case-insensitively.

    First-seen order and first-seen CASING: these are the rows of the Players
    step, and a name BGG recorded as "Mick" must not come back "mick" because
    a later play happened to lowercase it.
    """
    seen: dict[str, str] = {}
    for play in plays:
        for player in play.get("players") or []:
            name = player.get("name") or ""
            key = _match_key(name)
            if key and key not in seen:
                seen[key] = name
    return list(seen.values())


async def _read_plays(user_id: str, username: str) -> tuple[list[dict], datetime, bool, bool]:
    """(plays, fetched_at, reused, read_failed)."""
    cached = bgg_plays_cache.peek(user_id)
    if cached is not None:
        logger.info(
            "BGG plays preview: reusing a sync's read of %d plays for user=%s",
            len(cached.plays), user_id,
        )
        return cached.plays, cached.fetched_at, True, False

    fetched_at = datetime.now(timezone.utc)
    try:
        plays = await fetch_all_plays(user_id, username)
    except BggWarmUpError:
        # Not an error the user can act on, and not "nothing new" either. An
        # unread history is never cached — see bgg_plays_cache's header.
        logger.warning("BGG plays preview: warm-up exhausted for user=%s", user_id)
        return [], fetched_at, False, True

    bgg_plays_cache.store(user_id, fetched_at=fetched_at, plays=plays)
    return plays, fetched_at, False, False


def _summaries_for(sb: Client, bgg_ids: list[int]) -> dict[int, GameSummary]:
    """{bgg_id → GameSummary} for the games the catalog already has."""
    # Imported here rather than at module scope: bgg_link_routes imports this
    # package's siblings and game_routes imports models, so a top-level import
    # of a routes module from a service is the shape that has caused cycles
    # here before.
    from ..bgg_link_routes import _existing_game_map

    rows = _existing_game_map(sb, bgg_ids)
    return {bgg_id: GameSummary(**row) for bgg_id, row in rows.items()}


async def pending_plays(sb: Client, user_id: str, username: str) -> BggPendingPlaysResponse:
    """Every BGG play this account has not imported, newest first and capped."""
    raw, fetched_at, reused, read_failed = await _read_plays(user_id, username)

    if read_failed:
        return BggPendingPlaysResponse(
            bgg_username=username,
            fetched_at=fetched_at,
            read_failed=True,
        )

    already = await asyncio.to_thread(
        existing_bgg_play_ids, sb, user_id, [p["bgg_play_id"] for p in raw]
    )
    # BGG can repeat a play id across pages; keep one row per id. dict keeps
    # insertion order, so the last page to mention a play wins the same way the
    # retired write path let it.
    missing: dict[int, dict] = {
        p["bgg_play_id"]: p for p in raw if p["bgg_play_id"] not in already
    }
    total_new = len(missing)

    # Newest first, so a truncated preview brings over the plays the user is
    # most likely to still care about. `played_at` is a BGG date string in
    # ISO form, which sorts correctly as text.
    ordered = sorted(missing.values(), key=lambda p: p["played_at"], reverse=True)
    window = ordered[:MAX_BGG_PENDING_PLAYS]

    games = await asyncio.to_thread(
        _summaries_for, sb, sorted({p["bgg_id"] for p in window})
    )

    plays = [
        BggPendingPlay(
            bgg_play_id=p["bgg_play_id"],
            bgg_id=p["bgg_id"],
            bgg_game_name=p.get("bgg_game_name"),
            played_at=p["played_at"],
            notes=p.get("notes"),
            quantity=p.get("quantity") or 1,
            players=[
                BggPendingPlayer(
                    name=pl["name"],
                    username=pl.get("username"),
                    is_winner=bool(pl.get("is_winner")),
                )
                for pl in (p.get("players") or [])
            ],
            game=games.get(p["bgg_id"]),
        )
        for p in window
    ]

    logger.info(
        "BGG plays preview for user=%s: %d read, %d new, %d shown (reused=%s)",
        user_id, len(raw), total_new, len(plays), reused,
    )

    return BggPendingPlaysResponse(
        bgg_username=username,
        plays=plays,
        total_new=total_new,
        truncated=total_new > len(plays),
        fetched_at=fetched_at,
        reused_read=reused,
        read_failed=False,
        players=_distinct_player_names(window),
    )
