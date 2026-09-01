"""Shared helpers used across BoardgameBuddy services."""

from typing import Any

from fastapi import HTTPException

from ..models import BuddyEdgeResponse, GameSummary
from ..constants import PlayMode


# The JSONB-returning RPCs (migrations 036/037/042/046) signal gate failures
# with {"error": "<code>"} instead of raising, so a caller gets one round trip
# either way. This maps those codes onto the HTTP statuses the routes have
# always returned.
RPC_ERROR_STATUS: dict[str, tuple[int, str]] = {
    "not_found": (404, "Session not found"),
    "expired": (410, "Session expired"),
    "guest_name_required": (400, "display_name is required for guests"),
    "code_allocation_failed": (503, "Could not allocate session code"),
    "forbidden": (403, "Only the host can finalize"),
    "game_not_found": (404, "Game not found"),
    # Migration 046's host writes. `host_only` is separate from `forbidden`
    # rather than a reuse: forbidden's detail is finalize-specific, and
    # widening it would change bgb_finalize_session's message for no reason.
    "host_only": (403, "Only the host can update the session"),
    "roster_locked": (409, "Roster is locked once Play starts"),
    "participant_not_found": (404, "Participant not found"),
    "cannot_remove_host": (400, "Cannot remove the host"),
    "display_name_required": (400, "display_name is required"),
    # Ghost account claims (migration 069). None of these reuse `not_found`
    # above — its detail is session-specific ("Session not found") and
    # widening it would change bgb_finalize_session's message for no reason.
    "claim_not_found": (404, "Claim not found"),
    "not_pending": (409, "That request is no longer pending"),
    "already_linked": (409, "That ghost is already linked to your account"),
    "already_seated": (409, "You're already a player on one of those plays"),
    "own_roster": (400, "That's your own ghost — link it from Buddies instead"),
    "declined_twice": (409, "They've already declined that link"),
    "ghost_gone": (410, "That ghost is no longer on their plays"),
    "not_visible": (403, "You can't see that play"),
    # `invalid_transition` is deliberately absent: its detail is dynamic
    # (from/to), so update_phase composes and raises that one itself.
}


def raise_for_rpc_error(data: Any, what: str) -> None:
    """Raise the mapped HTTPException when an RPC returned an error envelope.

    `what` labels the RPC in the fallback message for an unmapped code.
    """
    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=502, detail=f"Empty {what} RPC response")
    error = data.get("error")
    if error:
        status, detail = RPC_ERROR_STATUS.get(error, (500, f"{what} RPC error: {error}"))
        raise HTTPException(status_code=status, detail=detail)


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
        .select("id, display_name, username, avatar, created_at")
        .in_("id", unique_ids)
        .execute()
    )
    return {r["id"]: r for r in (rows.data or [])}


def canonical_edge_pair(a: str, b: str) -> tuple[str, str]:
    """Return (lo, hi) so the pair maps to a canonical buddy_edges row."""
    return (a, b) if a < b else (b, a)


def edge_response(
    edge: dict[str, Any],
    viewer_id: str,
    profiles: dict[str, dict],
) -> BuddyEdgeResponse:
    """Shape a buddy_edges row from the viewer's side.

    Lives here rather than in buddy_service because both buddy_service and
    buddy_qr_service return accepted edges, and it pairs with
    fetch_profiles_by_ids above — the `profiles` argument is that call's output.
    """
    other_id = edge["user_b"] if edge["user_a"] == viewer_id else edge["user_a"]
    other = profiles.get(other_id) or {}
    return BuddyEdgeResponse(
        id=edge["id"],
        other_user_id=other_id,
        other_display_name=other.get("display_name") or "Unknown",
        other_username=other.get("username"),
        other_avatar=other.get("avatar"),
        accepted_at=edge.get("accepted_at"),
        created_at=edge["created_at"],
    )


