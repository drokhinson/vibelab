"""The Board Game Arena sweep: history → draft plays the wizard can review.

Sits between `bga_client` (identity and transport) and the import wizard. It
writes NOTHING to the plays tables — its whole output is a draft held in the
user's browser until they press the button on the review screen. That is why
the sweep runs in-handler behind an in-process ledger rather than as a
BackgroundTask over a queue table; `bga_progress.py`'s docstring has the full
argument.

THE SHAPE OF THE SWEEP, and the three bounds on it:

  1. Walk `getGames` pages newest-first and STOP AT THE FIRST TABLE ALREADY
     IMPORTED. BGA history is chronological, so that early exit is what makes
     every run after the first cheap — the second import of a heavy account
     costs one page, not five hundred.
  2. Cap it. BGA_MAX_TABLES / BGA_MAX_PAGES / BGA_SWEEP_BUDGET_SECONDS, first
     one to trip wins. Past a cap the result is `truncated` and the wizard
     tells the user to run it again. The history is still complete ACROSS runs,
     bounded per request — which is the only way "import everything" survives
     contact with a 2-second throttle inside one HTTP request.
  3. Enrich only what needs it. If BGA's history pages already carry rosters
     and scores, the DETAIL phase never runs and a full history is a handful of
     requests. If they do not, it runs per table — over tables not already
     imported, which is why the known-id filter happens BEFORE any detail call
     rather than after.

RESOLVING A HANDLE TO A PERSON, best evidence first:

  VIEWER         the handle is the importer's own linked handle
  REMEMBERED     boardgamebuddy_bga_player_links says who this is
  CROSS_ACCOUNT  another account has linked this exact handle
  FUZZY          left to the client — the name ranker lives there
  NONE           a new ghost

The first two are applied silently. CROSS_ACCOUNT is deliberately NOT: it is
somebody else's claim about who a handle belongs to, and seating a stranger at
your table on the strength of a shared username is not a thing to do quietly.
It is returned as a suggestion carrying its reason, and the wizard shows it as
a match the user can undo.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import date
from typing import Any

from supabase import Client

from .. import bga_endpoints as bga
from ..bga_client import fetch_history_page, fetch_table_info
from ..constants import BgaFetchPhase, BgaMatchReason
from ..models import (
    BgaDraftSeat,
    BgaDraftTable,
    BgaFetchResponse,
    BgaHandleMatch,
)
from . import bga_progress
from .play_import_service import match_games

logger = logging.getLogger(__name__)


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


# ── Reads ────────────────────────────────────────────────────────────────────


def _known_table_ids(sb: Client, user_id: str) -> set[int]:
    """Every BGA table this user has already imported.

    One read of one indexed column (idx_bgb_plays_user_bga_table), not a
    per-table existence check: the sweep tests membership once per history row
    and an N+1 here would be a query per table.
    """
    res = (
        sb.table("boardgamebuddy_plays")
        .select("bga_table_id")
        .eq("user_id", user_id)
        .not_.is_("bga_table_id", "null")
        .execute()
    )
    ids: set[int] = set()
    for row in res.data or []:
        value = row.get("bga_table_id")
        if value is not None:
            try:
                ids.add(int(value))
            except (TypeError, ValueError):
                continue
    return ids


def _remembered_links(sb: Client, user_id: str, handles: list[str]) -> dict[str, dict]:
    """This owner's remembered handle → person mappings, keyed lowercase."""
    if not handles:
        return {}
    res = (
        sb.table("boardgamebuddy_bga_player_links")
        .select("bga_handle, player_user_id, player_display_name")
        .eq("owner_id", user_id)
        .execute()
    )
    wanted = {h.lower() for h in handles}
    out: dict[str, dict] = {}
    for row in res.data or []:
        key = str(row.get("bga_handle") or "").lower()
        if key in wanted:
            out[key] = row
    return out


def _cross_account(sb: Client, handles: list[str]) -> dict[str, dict]:
    """Accounts that have linked one of these handles, keyed lowercase.

    Returns only the public profile fields the picker renders — never
    `bga_username` echoed back, and never anything from the credential columns.
    The disclosure this makes ("some account has linked handle X") is the same
    class `ImportPeople.searchEveryone` already makes app-wide.
    """
    if not handles:
        return {}
    res = (
        sb.table("boardgamebuddy_profiles")
        .select("id, display_name, username, avatar, bga_username")
        .in_("bga_username", handles)
        .execute()
    )
    out: dict[str, dict] = {}
    for row in res.data or []:
        key = str(row.get("bga_username") or "").lower()
        if not key:
            continue
        out[key] = {
            "user_id": row.get("id"),
            "display_name": row.get("display_name"),
            "username": row.get("username"),
            "avatar": row.get("avatar"),
        }
    return out


# ── The sweep ────────────────────────────────────────────────────────────────


async def _collect_stubs(
    user_id: str,
    player_id: str,
    known: set[int],
    progress: bga_progress.BgaFetchProgress,
) -> tuple[list[bga.BgaTableStub], int, bool]:
    """Walk history pages until a known table, a cap, or the end.

    Returns (new stubs, how many known tables were seen, truncated).
    """
    max_tables = _int_env("BGA_MAX_TABLES", 500)
    max_pages = _int_env("BGA_MAX_PAGES", 20)
    budget = _float_env("BGA_SWEEP_BUDGET_SECONDS", 90.0)
    deadline = time.monotonic() + budget

    stubs: list[bga.BgaTableStub] = []
    seen_known = 0
    truncated = False
    page = 1

    progress.begin(BgaFetchPhase.HISTORY, detail="Reading your game history")

    while page <= max_pages:
        if time.monotonic() > deadline:
            truncated = True
            break

        body = await fetch_history_page(user_id, player_id, page)
        rows, has_more = bga.parse_table_page(body)
        if not rows:
            break

        hit_known = False
        for stub in rows:
            if stub.table_id in known:
                seen_known += 1
                # Newest-first, so the first already-imported table means
                # everything below it is imported too. This early exit is the
                # whole reason a second import is cheap.
                hit_known = True
                break
            stubs.append(stub)
            if len(stubs) >= max_tables:
                truncated = True
                break

        progress.tick(
            BgaFetchPhase.HISTORY,
            len(stubs),
            detail=f"{len(stubs)} new so far",
        )

        if hit_known or truncated or not has_more:
            break
        page += 1
    else:
        # Ran out of pages rather than out of history.
        truncated = True

    if truncated:
        progress.note_truncated()
    return stubs, seen_known, truncated


async def _enrich(
    user_id: str,
    stubs: list[bga.BgaTableStub],
    progress: bga_progress.BgaFetchProgress,
) -> list[bga.BgaTable]:
    """Turn stubs into complete tables, calling tableinfos only where needed."""
    ready: list[bga.BgaTable] = []
    needs_detail = [s for s in stubs if s.needs_detail]

    for stub in stubs:
        if not stub.needs_detail:
            table = bga.table_from_stub(stub)
            if table is not None:
                ready.append(table)

    if not needs_detail:
        progress.skip(BgaFetchPhase.DETAIL, detail="The history already had every table's players")
        return ready

    progress.begin(BgaFetchPhase.DETAIL, total=len(needs_detail))
    for index, stub in enumerate(needs_detail, start=1):
        try:
            body = await fetch_table_info(user_id, stub.table_id)
        except Exception as exc:  # noqa: BLE001 — one bad table is not a bad import
            logger.warning("BGA table %s detail failed: %s", stub.table_id, exc)
            progress.tick(BgaFetchPhase.DETAIL, index)
            continue
        table = bga.parse_table_info(body, fallback=stub)
        if table is not None:
            ready.append(table)
        progress.tick(BgaFetchPhase.DETAIL, index)

    # Dated newest-first, undated last. `is not None` leads the key so the two
    # groups never compare a date against None.
    ready.sort(key=lambda t: (t.ended_at is not None, t.ended_at or date.min), reverse=True)
    return ready


def _resolve_handles(
    sb: Client,
    user_id: str,
    handles: list[str],
    viewer_handle: str,
) -> list[BgaHandleMatch]:
    """Apply the resolution ladder. See the module docstring."""
    remembered = _remembered_links(sb, user_id, handles)
    cross = _cross_account(sb, handles)
    viewer_key = (viewer_handle or "").lower()

    matches: list[BgaHandleMatch] = []
    for handle in handles:
        key = handle.lower()

        if viewer_key and key == viewer_key:
            matches.append(
                BgaHandleMatch(handle=handle, reason=BgaMatchReason.VIEWER, player_user_id=user_id)
            )
            continue

        link = remembered.get(key)
        if link:
            matches.append(
                BgaHandleMatch(
                    handle=handle,
                    reason=BgaMatchReason.REMEMBERED,
                    player_user_id=link.get("player_user_id"),
                    player_display_name=link.get("player_display_name"),
                )
            )
            continue

        account = cross.get(key)
        if account:
            matches.append(
                BgaHandleMatch(
                    handle=handle,
                    reason=BgaMatchReason.CROSS_ACCOUNT,
                    player_user_id=account.get("user_id"),
                    player_display_name=account.get("display_name"),
                    username=account.get("username"),
                    avatar=account.get("avatar"),
                )
            )
            continue

        matches.append(BgaHandleMatch(handle=handle, reason=BgaMatchReason.NONE))

    return matches


def _draft_table(table: bga.BgaTable) -> BgaDraftTable:
    """One BGA table as the wizard's draft wants it.

    Winner is rank 1, from BGA's own ranking — the site already decided who won
    and re-deriving it from scores would disagree with it on any game where the
    low score wins. Both stay editable in the shared review.
    """
    seats = [
        BgaDraftSeat(
            handle=seat.handle,
            score=seat.score,
            rank=seat.rank,
            is_winner=seat.rank == 1,
        )
        for seat in table.seats
    ]
    return BgaDraftTable(
        bga_table_id=table.table_id,
        game_name=table.game_name,
        bga_game_id=table.bga_game_id,
        played_at=table.ended_at,
        seats=seats,
    )


async def sweep(user_id: str, player_id: str, viewer_handle: str) -> BgaFetchResponse:
    """Everything the wizard needs to open its Players step, in one call."""
    from db import get_supabase

    sb = get_supabase()
    progress = bga_progress.BgaFetchProgress(user_id)

    try:
        progress.begin(BgaFetchPhase.SIGN_IN, detail="Signing in to Board Game Arena")
        progress.begin(BgaFetchPhase.KNOWN, detail="Checking what you've already imported")
        known = await asyncio.to_thread(_known_table_ids, sb, user_id)

        stubs, seen_known, truncated = await _collect_stubs(user_id, player_id, known, progress)
        tables = await _enrich(user_id, stubs, progress)

        progress.begin(BgaFetchPhase.MATCH, detail="Matching games and players")

        handles: list[str] = []
        seen: set[str] = set()
        for table in tables:
            for seat in table.seats:
                key = seat.handle.lower()
                if key not in seen:
                    seen.add(key)
                    handles.append(seat.handle)

        game_names: list[str] = []
        seen_games: set[str] = set()
        for table in tables:
            key = " ".join(table.game_name.split()).lower()
            if key and key not in seen_games:
                seen_games.add(key)
                game_names.append(table.game_name)

        games, matches = await asyncio.gather(
            asyncio.to_thread(match_games, sb, user_id, game_names),
            asyncio.to_thread(_resolve_handles, sb, user_id, handles, viewer_handle),
        )

        progress.finish()
    except Exception as exc:  # noqa: BLE001 — the ledger must record why it stopped
        progress.fail(str(exc))
        raise

    return BgaFetchResponse(
        tables=[_draft_table(t) for t in tables],
        handles=matches,
        games=games,
        skipped=seen_known,
        truncated=truncated,
    )


def remember_links(sb: Client, user_id: str, links: list[dict[str, Any]]) -> int:
    """Upsert this owner's handle → person mappings. Returns how many landed.

    Upsert on (owner_id, lower(bga_handle)) is expressed by deleting the
    handles being written and re-inserting: PostgREST's on_conflict wants a
    unique CONSTRAINT and ours is a functional unique INDEX, which it cannot
    name. The delete and insert are per-request and owner-scoped, so the worst
    a race costs is one re-assignment the user can redo.
    """
    rows: list[dict[str, Any]] = []
    for link in links:
        handle = str(link.get("bga_handle") or "").strip()
        user_ref = link.get("player_user_id")
        display = str(link.get("player_display_name") or "").strip()
        if not handle or (not user_ref and not display):
            continue
        rows.append(
            {
                "owner_id": user_id,
                "bga_handle": handle,
                "player_user_id": user_ref,
                "player_display_name": display or None,
            }
        )
    if not rows:
        return 0

    handles = [r["bga_handle"] for r in rows]
    sb.table("boardgamebuddy_bga_player_links").delete().eq("owner_id", user_id).in_(
        "bga_handle", handles
    ).execute()
    sb.table("boardgamebuddy_bga_player_links").insert(rows).execute()
    return len(rows)
