"""Shared helpers used across BoardgameBuddy services."""

from typing import Any, Optional

from ..models import GameSummary
from ..constants import PlayMode


_GAME_SELECT = (
    "id, bgg_id, name, year_published, min_players, max_players, "
    "playing_time, thumbnail_url, image_url, theme_color, is_expansion, "
    "base_game_bgg_id, expansion_color, rulebook_url, play_mode"
)


def game_select_clause() -> str:
    """The PostgREST select clause for hydrating a GameSummary."""
    return _GAME_SELECT


def game_summary_from_row(row: dict[str, Any]) -> GameSummary:
    """Build a GameSummary from a boardgamebuddy_games row."""
    return GameSummary(
        id=row["id"],
        bgg_id=row.get("bgg_id"),
        name=row["name"],
        year_published=row.get("year_published"),
        min_players=row.get("min_players"),
        max_players=row.get("max_players"),
        playing_time=row.get("playing_time"),
        thumbnail_url=row.get("thumbnail_url"),
        image_url=row.get("image_url"),
        theme_color=row.get("theme_color"),
        is_expansion=bool(row.get("is_expansion", False)),
        base_game_bgg_id=row.get("base_game_bgg_id"),
        expansion_color=row.get("expansion_color"),
        rulebook_url=row.get("rulebook_url"),
        play_mode=PlayMode(row.get("play_mode") or PlayMode.COMPETITIVE.value),
    )


def fetch_games_by_ids(sb, game_ids: list[str]) -> dict[str, GameSummary]:
    """Bulk-fetch GameSummary rows keyed by id. Returns {} on empty input."""
    if not game_ids:
        return {}
    unique_ids = list(set(game_ids))
    rows = (
        sb.table("boardgamebuddy_games")
        .select(_GAME_SELECT)
        .in_("id", unique_ids)
        .execute()
    )
    return {r["id"]: game_summary_from_row(r) for r in (rows.data or [])}


def fetch_profiles_by_ids(sb, user_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Bulk-fetch profile rows keyed by id. Returns {} on empty input."""
    if not user_ids:
        return {}
    unique_ids = list(set(user_ids))
    rows = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, avatar, created_at")
        .in_("id", unique_ids)
        .execute()
    )
    return {r["id"]: r for r in (rows.data or [])}


def canonical_edge_pair(a: str, b: str) -> tuple[str, str]:
    """Return (lo, hi) so the pair maps to a canonical buddy_edges row."""
    return (a, b) if a < b else (b, a)


def rpc(sb, name: str, params: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
    """Execute a Supabase RPC and return rows (or empty list on null)."""
    res = sb.rpc(name, params or {}).execute()
    return res.data or []
