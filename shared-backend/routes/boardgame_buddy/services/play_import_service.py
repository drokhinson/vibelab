"""Play importer — catalog matching, the batched write, and undo.

Jobs, all sitting between the model's reply (services/play_import_ai.py)
and the plays table:

  • match_games — every play needs a real boardgamebuddy_games row, and the
    model only ever gives a name. Resolving here rather than in the client
    means the Games step opens already populated instead of firing a search
    per row after it paints.
  • import_plays — one chunk of the wizard's write, as a single RPC.
  • list_imports / delete_import_group / delete_import_batch — the undo side
    (migration 007). A run is deletable from its own feed card; a whole import
    from Settings. Both RPCs are owner-scoped in their WHERE clause, so an id
    belonging to somebody else deletes nothing and reports zero.
"""

import logging
from typing import Any, Optional

from ..constants import IMPORT_GAME_CANDIDATES
from ..models import (
    GameSummary,
    ParsedGameRef,
    PlayCreate,
    PlayImportListResponse,
    PlayImportResponse,
    PlayImportResultItem,
    PlayImportSummary,
)
from ._helpers import game_summary_from_row

logger = logging.getLogger(__name__)


def _match_key(name: str) -> str:
    return " ".join(str(name or "").split()).lower()


def match_games(sb, viewer_id: str, names: list[str]) -> list[ParsedGameRef]:
    """Resolve each distinct game name against the catalog.

    One boardgamebuddy_search_games call per NAME, never per play: a note
    holds one to three games however many plays it records, so this is a small
    bounded fan-out rather than an N+1 (.claude/rules/performance-caching.md).

    `confident` marks the case the wizard can pre-select without asking —
    exactly one candidate whose name matches what the note said, ignoring case
    and surrounding whitespace. Two games called the same thing, or a near
    miss like "Carcassone", both fall through to the picker.
    """
    refs: list[ParsedGameRef] = []
    for name in names:
        rows: list[dict[str, Any]] = []
        try:
            rows = (
                sb.rpc("boardgamebuddy_search_games", {
                    "p_viewer": viewer_id,
                    "p_query": name,
                    "p_limit": IMPORT_GAME_CANDIDATES,
                    "p_include_expansions": False,
                })
                .execute()
                .data
                or []
            )
        except Exception as exc:  # noqa: BLE001 — a failed match is not a failed parse
            # The Games step is a picker either way; an empty candidate list
            # costs the user a search, a 500 costs them the whole import.
            logger.warning("game match failed for %r: %s", name, exc)

        candidates: list[GameSummary] = []
        for row in rows:
            try:
                candidates.append(game_summary_from_row(row))
            except (KeyError, TypeError, ValueError):
                continue

        wanted = _match_key(name)
        exact = [c for c in candidates if _match_key(c.name) == wanted]
        refs.append(ParsedGameRef(
            name=name,
            candidates=candidates,
            confident=len(exact) == 1,
        ))
    return refs


def import_plays(sb, user_id: str, plays: list[PlayCreate]) -> PlayImportResponse:
    """Write one chunk of an import. One bgb_import_plays call.

    Per-play outcomes come back rather than a single success flag: a chunk
    where one play names a game that has since been deleted must still land
    the other forty-nine, and the wizard's ledger has to be able to say which
    one didn't.
    """
    payload = {"plays": [p.model_dump(mode="json") for p in plays]}
    data = (
        sb.rpc("bgb_import_plays", {"p_user": user_id, "p_payload": payload})
        .execute()
        .data
        or {}
    )
    results = [
        PlayImportResultItem(
            index=int(r.get("index", i)),
            id=r.get("id"),
            duplicate=bool(r.get("duplicate")),
            error=r.get("error"),
        )
        for i, r in enumerate(data.get("results") or [])
        if isinstance(r, dict)
    ]
    return PlayImportResponse(
        imported=int(data.get("imported") or 0),
        duplicate=int(data.get("duplicate") or 0),
        failed=int(data.get("failed") or 0),
        results=results,
    )


def distinct_player_names(plays: list[Any]) -> list[str]:
    """Every player name in the parse, deduped case-insensitively.

    First-seen order, and first-seen CASING: the Players step shows these back
    to the user, and a name they wrote as "Mick" should not come back "mick"
    because a later line happened to be lowercase.
    """
    seen: dict[str, str] = {}
    for play in plays:
        for player in play.players:
            key = _match_key(player.name)
            if key and key not in seen:
                seen[key] = player.name
    return list(seen.values())


def distinct_game_names(plays: list[Any]) -> list[str]:
    """Every game name in the parse, deduped case-insensitively."""
    seen: dict[str, str] = {}
    for play in plays:
        key = _match_key(play.game)
        if key and key not in seen:
            seen[key] = play.game
    return list(seen.values())


def list_imports(sb, user_id: str) -> PlayImportListResponse:
    """Past imports for the Settings list, newest first."""
    rows = sb.rpc("bgb_list_imports", {"p_user": user_id}).execute().data or []
    return PlayImportListResponse(
        imports=[PlayImportSummary(**r) for r in rows if isinstance(r, dict)]
    )


def _deleted_count(data: Any) -> int:
    return int((data or {}).get("deleted") or 0) if isinstance(data, dict) else 0


def delete_import_group(sb, user_id: str, group_id: str) -> int:
    """Delete one run of identical imported plays. Returns rows removed."""
    data = (
        sb.rpc("bgb_delete_import_group", {"p_user": user_id, "p_group": group_id})
        .execute()
        .data
    )
    return _deleted_count(data)


def delete_import_batch(sb, user_id: str, batch_id: str) -> int:
    """Delete everything one import wrote. Returns rows removed."""
    data = (
        sb.rpc("bgb_delete_import_batch", {"p_user": user_id, "p_batch": batch_id})
        .execute()
        .data
    )
    return _deleted_count(data)
