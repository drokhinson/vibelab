"""Play importer — catalog matching, the batched write, and undo.

Jobs, all sitting between the model's reply (services/play_import_ai.py)
and the plays table:

  • match_games — every play needs a real boardgamebuddy_games row, and the
    model only ever gives a name. Resolving here rather than in the client
    means the Games step opens already populated instead of firing a search
    per row after it paints.
  • import_plays — one chunk of the wizard's write, as a single RPC.
  • list_imports / import_detail — the reading side. The first is the imports
    spoke's index (and the count on Settings' row); the second is one import
    and what it wrote, collapsed to runs.
  • delete_import_group / delete_import_batch — the undo side (migration 007).
    A run is deletable from its own feed card and from the imports spoke; a
    whole import from the spoke's detail screen. Both RPCs are owner-scoped in
    their WHERE clause, so an id belonging to somebody else deletes nothing and
    reports zero.

There is no import OBJECT anywhere in this file, and there is none in the
database either: a batch is a GROUP BY over boardgamebuddy_plays.import_batch_id,
with no table, no name and no note of its own. "Editing an import" can only
ever mean editing the plays inside it.
"""

import logging
from supabase import Client
from typing import Any

from ..constants import IMPORT_GAME_CANDIDATES
from ..models import (
    GameSummary,
    ParsedGameRef,
    PlayCreate,
    PlayImportDetailResponse,
    PlayImportListResponse,
    PlayImportResponse,
    PlayImportResultItem,
    PlayImportRunItem,
    PlayImportSummary,
)
from ._helpers import game_summary_from_row

logger = logging.getLogger(__name__)


def _match_key(name: str) -> str:
    return " ".join(str(name or "").split()).lower()


def match_games(sb: Client, viewer_id: str, names: list[str]) -> list[ParsedGameRef]:
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


def import_plays(sb: Client, user_id: str, plays: list[PlayCreate]) -> PlayImportResponse:
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


def list_imports(sb: Client, user_id: str) -> PlayImportListResponse:
    """Past imports for the Settings list, newest first."""
    rows = sb.rpc("bgb_list_imports", {"p_user": user_id}).execute().data or []
    return PlayImportListResponse(
        imports=[PlayImportSummary(**r) for r in rows if isinstance(r, dict)]
    )


def import_detail(sb: Client, user_id: str, batch_id: str) -> PlayImportDetailResponse | None:
    """One import and the runs it wrote, or None when it is not this user's.

    Grouped in PYTHON rather than in a sibling RPC to bgb_list_imports, for two
    reasons. The batch summary is the same five aggregates that RPC already
    computes, and every one of them falls out of the rows fetched here for
    free — writing them a second time in SQL is a second place for them to
    drift. And the fiddly half, resolving a roster's display names, is already
    written as play_routes._fetch_players.

    The cost is bounded by construction: MAX_IMPORT_PLAYS caps a batch at 500
    rows, and the read is an exact match on
    idx_bgb_plays_import_batch (user_id, import_batch_id).

    None rather than an empty response for a batch that is not this user's: the
    read is owner-scoped in the .eq() below, so a foreign batch and one that
    never existed produce the same answer — see the route's 404.
    """
    rows = (
        sb.table("boardgamebuddy_plays")
        .select(
            "id, game_id, game_name, game_thumbnail_url, played_at, notes, "
            "created_at, imported_at, import_group_id"
        )
        .eq("user_id", user_id)
        .eq("import_batch_id", batch_id)
        .execute()
        .data
        or []
    )
    if not rows:
        return None

    # COALESCE(import_group_id, id): a run keys on its group, a one-off on
    # itself. Both come out of the loop as the same shape.
    groups: dict[str, list[dict]] = {}
    for row in rows:
        groups.setdefault(row.get("import_group_id") or row["id"], []).append(row)

    # (sort key, run) pairs: the representative's created_at is the tiebreak
    # and is not a field of the response, so it rides alongside rather than
    # being looked up again afterwards.
    ordered: list[tuple[tuple[str, str], PlayImportRunItem]] = []
    for members in groups.values():
        # Lowest id, the same representative bgb_plays_page and bgb_feed_plays
        # pick with ORDER BY id LIMIT 1 — uuids compare as text there too.
        rep = min(members, key=lambda r: str(r["id"]))
        ordered.append((
            (str(rep["played_at"]), str(rep.get("created_at") or "")),
            PlayImportRunItem(
                play_id=rep["id"],
                import_group_id=rep.get("import_group_id"),
                group_count=len(members),
                game_id=rep["game_id"],
                game_name=rep["game_name"],
                game_thumbnail=rep.get("game_thumbnail_url"),
                played_at=rep["played_at"],
                notes=rep.get("notes"),
            ),
        ))
    # Newest first, matching bgb_plays_page's played_at DESC, created_at DESC so
    # a run does not sit in a different place here than on the plays log.
    ordered.sort(key=lambda pair: pair[0], reverse=True)
    runs = [run for _, run in ordered]

    # Imported here, not at module scope: play_routes imports .services, so a
    # top-level import would close the cycle.
    from ..play_routes import _fetch_players

    players_by_play = _fetch_players(sb, [r.play_id for r in runs])
    for run in runs:
        run.players = players_by_play.get(run.play_id, [])

    imported = [r.get("imported_at") for r in rows if r.get("imported_at")]
    played = [r["played_at"] for r in rows if r.get("played_at")]
    batch = PlayImportSummary(
        batch_id=batch_id,
        imported_at=min(imported) if imported else None,
        play_count=len(rows),
        game_count=len({r["game_id"] for r in rows}),
        # Capped at four to mirror bgb_list_imports, so the same import reads
        # the same on the spoke's index and in its header. game_count above
        # stays exact.
        game_names=sorted({r["game_name"] for r in rows})[:4],
        first_played_at=min(played) if played else None,
        last_played_at=max(played) if played else None,
    )
    return PlayImportDetailResponse(batch=batch, runs=runs)


def _deleted_count(data: Any) -> int:
    return int((data or {}).get("deleted") or 0) if isinstance(data, dict) else 0


def delete_import_group(sb: Client, user_id: str, group_id: str) -> int:
    """Delete one run of identical imported plays. Returns rows removed."""
    data = (
        sb.rpc("bgb_delete_import_group", {"p_user": user_id, "p_group": group_id})
        .execute()
        .data
    )
    return _deleted_count(data)


def delete_import_batch(sb: Client, user_id: str, batch_id: str) -> int:
    """Delete everything one import wrote. Returns rows removed."""
    data = (
        sb.rpc("bgb_delete_import_batch", {"p_user": user_id, "p_batch": batch_id})
        .execute()
        .data
    )
    return _deleted_count(data)
