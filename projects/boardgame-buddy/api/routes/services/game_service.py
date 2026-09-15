"""Game catalog reads that are shared across routes.

Currently just the recently-played list — the host flow's game picker seeds
its dropdown from this, and `/bootstrap` preloads it on login so the picker
opens with data on first paint.
"""

from supabase import Client

from ..models import GameSummary
from ._helpers import game_select_clause


def recently_played(sb: Client, viewer_id: str, limit: int = 6) -> list[GameSummary]:
    """Distinct games the viewer has plays for, most recent first.

    "Has plays for" is the same rule every other play-derived surface uses:
    plays the viewer logged, OR plays someone else logged that list the viewer
    as a player. Reads through bgb_play_stats (migration 039), which already
    aggregates that in SQL and returns one row per game with its last_played_at.

    This used to scan the viewer's 200 most recent OWN play rows and de-dupe in
    Python, which both missed games a buddy logged them into and could truncate
    a heavy BGG-synced history before reaching `limit` distinct games.
    """
    stats = (
        sb.rpc("bgb_play_stats", {"p_viewer": viewer_id, "p_game_ids": None})
        .execute()
        .data
        or []
    )
    ranked = sorted(
        (r for r in stats if r.get("last_played_at")),
        key=lambda r: r["last_played_at"],
        reverse=True,
    )
    ordered_ids = [r["game_id"] for r in ranked[:limit]]
    if not ordered_ids:
        return []
    rows = (
        sb.table("boardgamebuddy_games")
        .select(game_select_clause())
        .in_("id", ordered_ids)
        .execute()
        .data
        or []
    )
    by_id = {r["id"]: r for r in rows}
    return [GameSummary(**by_id[gid]) for gid in ordered_ids if gid in by_id]
