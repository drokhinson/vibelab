"""BoardGameGeek account linking + collection/plays import.

Flow:
  1. User links a BGG account (POST /bgg/link with username + password). The
     backend POSTs to BGG's /login/api/v1, captures the SessionID + bgg
     cookies, stores them and a Fernet-encrypted copy of the password on the
     profile (see bgg_credentials.py).
  2. POST /bgg/sync calls /collection?showprivate=1 and /plays AS that user
     via fetch_bgg_as_user, which transparently re-logs in when the cookies
     expire. Public catalog calls (search, /thing) keep going through
     fetch_bgg with just the shared bearer token.
  3. Rows referencing games we already have are upserted immediately, including
     the private fields (purchase price, private comments, …).
  4. Rows referencing games we don't have are persisted as pending imports;
     a BackgroundTask drains the queue by calling import_game_from_bgg() and
     materializing the deferred collection / play rows.
  5. The FE polls GET /bgg/sync/status until pending_count hits zero, and uses
     auth_state to decide between "Link", "Re-link required", and "Linked".

Idempotent: collection rows upsert on (user_id, game_id); plays dedup on
(user_id, bgg_play_id). Re-running sync is always safe.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import BackgroundTasks, Depends, HTTPException
from supabase import Client

from db import get_supabase

from . import router
from .game_routes import (
    COLLECTION_DENORM_GAME_FIELDS,
    collection_denormalized_from_game,
    play_denormalized_from_game,
)
from .bgg_client import (
    BggWarmUpError,
    clear_user_session,
    fetch_bgg_as_user,
    parse_bgg_xml,
    store_user_credentials,
)
# The collection read layer lives in its own module now — the BgB->BGG
# comparison needs the same sweep. See bgg_collection_read for why the
# (bgg_id, status, private) contract this module keeps is an adapter over a
# fuller one rather than a widened tuple.
from .bgg_collection_read import (
    BGG_THROTTLE_SECONDS as _WORKER_THROTTLE_SECONDS,
    BggCollectionItem,
    _fetch_collection_batched,
    collection_rows_from_items,
)
from .bgg_credentials import login_to_bgg
from .constants import BggAuthState
from .dependencies import CurrentUser, get_current_user
from .game_routes import import_game_from_bgg
from .models import (
    BggLinkBody,
    BggLinkResponse,
    BggSyncStatus,
    BggSyncSummary,
)
from .services import bgg_check_cache

logger = logging.getLogger(__name__)


# _WORKER_THROTTLE_SECONDS is imported from bgg_collection_read: the sweep and
# this worker throttle for the same reason and must not drift apart.
_WORKER_BATCH_SIZE = 50
_WORKER_MAX_ATTEMPTS = 3


# ── Helpers ──────────────────────────────────────────────────────────────────


def _existing_game_map(sb: Client, bgg_ids: list[int]) -> dict[int, dict]:
    """Bulk-resolve {bgg_id → game row} for games already in our catalog.

    Returns the full denormalization payload set (covers both collection and
    play denorm fields from migration 020) plus `id` so callers can pass the
    row straight into _upsert_collection_row / _materialize_play without a
    second round trip per (bgg_id) during sync.
    """
    if not bgg_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_games")
        .select("id, " + COLLECTION_DENORM_GAME_FIELDS)
        .in_("bgg_id", bgg_ids)
        .execute()
    )
    return {r["bgg_id"]: r for r in (rows.data or []) if r.get("bgg_id")}


def _prev_owned_game_ids(sb: Client, user_id: str) -> set[str]:
    """Game ids this user has marked "previously owned" in the app.

    See _hold_prev_owned for why a sync needs to know. One bounded read per
    sync — the set is small by nature, and it is the whole set rather than a
    per-game lookup because the bulk writer would otherwise do one read a row.
    """
    rows = (
        sb.table("boardgamebuddy_collections")
        .select("game_id")
        .eq("user_id", user_id)
        .eq("status", "prev_owned")
        .execute()
        .data
        or []
    )
    return {r["game_id"] for r in rows}


def _hold_prev_owned(status: str, prev_owned_ids: set[str], game_id: str) -> str:
    """Never let a sync resurrect a game the user marked "previously owned".

    BGG's own `own` flag is not curated the way an in-app tap is: people leave
    a sold game flagged own for years, and the whole point of prev_owned is
    that the user told us they let it go. So a local prev_owned row outranks an
    incoming `owned` and the sync leaves it alone. Every other transition still
    lands — a game that moves to wishlist on BGG still moves here.
    """
    if status == "owned" and game_id in prev_owned_ids:
        return "prev_owned"
    return status


def _upsert_collection_row(
    sb: Client,
    user_id: str,
    game: dict,
    status: str,
    private: Optional[dict] = None,
) -> None:
    """Upsert one collection row using the existing (user_id, game_id) UNIQUE.

    `game` is the full row returned by _existing_game_map or import_game_from_bgg;
    its denormalized fields (migration 020) are written inline so the new
    collection row doesn't need a sync trigger.

    `private` is the dict produced by _parse_collection (private fields from
    BGG's <privateinfo>). Keys missing from BGG come through as None so
    re-syncing after BGG-side deletion still nulls our copy.
    """
    # One row at a time here (the pending-import worker), so scope the
    # prev_owned check to this game rather than reading the user's whole set.
    if status == "owned":
        existing = (
            sb.table("boardgamebuddy_collections")
            .select("status")
            .eq("user_id", user_id)
            .eq("game_id", game["id"])
            .limit(1)
            .execute()
            .data
            or []
        )
        if existing and existing[0].get("status") == "prev_owned":
            status = "prev_owned"  # see _hold_prev_owned
    sb.table("boardgamebuddy_collections").upsert(
        _collection_payload(user_id, game, status, private),
        on_conflict="user_id,game_id",
    ).execute()


def _collection_payload(
    user_id: str,
    game: dict,
    status: str,
    private: Optional[dict] = None,
) -> dict:
    """The row _upsert_collection_row writes. Shared with the batch path."""
    payload: dict = {
        "user_id": user_id,
        "game_id": game["id"],
        "status": status,
        **collection_denormalized_from_game(game),
    }
    if private is not None:
        payload.update({
            "bgg_private_comment": private.get("private_comment"),
            "bgg_acquired_from": private.get("acquired_from"),
            "bgg_acquisition_date": private.get("acquisition_date"),
            "bgg_purchase_price": private.get("purchase_price"),
            "bgg_purchase_currency": private.get("purchase_currency"),
            "bgg_inventory_location": private.get("inventory_location"),
            "bgg_quantity": private.get("quantity"),
        })
    return payload


def _materialize_play(
    sb: Client,
    user_id: str,
    game: dict,
    play_payload: dict,
) -> None:
    """Insert a play + its play_players from a BGG-derived payload.

    `game` is the full row returned by _existing_game_map or
    import_game_from_bgg; its denormalized fields land on the play row inline.

    Dedups on (user_id, bgg_play_id): if a row with this BGG play id already
    exists for this user we skip re-inserting and don't touch its players.
    """
    bgg_play_id = play_payload.get("bgg_play_id")

    if bgg_play_id is not None:
        already = (
            sb.table("boardgamebuddy_plays")
            .select("id")
            .eq("user_id", user_id)
            .eq("bgg_play_id", bgg_play_id)
            .execute()
        )
        if already.data:
            return

    play_result = (
        sb.table("boardgamebuddy_plays")
        .insert(_play_row(user_id, game, play_payload))
        .execute()
    )
    if not play_result.data:
        return
    play_id = play_result.data[0]["id"]

    rows = _player_rows(play_id, play_payload)
    if rows:
        sb.table("boardgamebuddy_play_players").insert(rows).execute()


def _play_row(user_id: str, game: dict, play_payload: dict) -> dict:
    """The boardgamebuddy_plays row for one BGG play. Shared with the batch path."""
    return {
        "user_id": user_id,
        "game_id": game["id"],
        "played_at": play_payload["played_at"],
        "notes": play_payload.get("notes"),
        "bgg_play_id": play_payload.get("bgg_play_id"),
        **play_denormalized_from_game(game),
    }


def _player_rows(play_id: str, play_payload: dict) -> list[dict]:
    """play_players rows for one play, skipping blank names.

    Writes through the migration-009 columns so we don't touch the dropped
    buddy_id (migration 013).
    """
    out: list[dict] = []
    for player in play_payload.get("players") or []:
        name = (player.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "play_id": play_id,
            "player_display_name": name,
            "is_winner": bool(player.get("is_winner")),
        })
    return out


def _queue_pending(
    sb: Client,
    user_id: str,
    bgg_id: int,
    kind: str,
    payload: dict,
) -> None:
    """Queue a row for the background worker. Idempotent on (user, bgg_id, kind, status='pending')."""
    sb.table("boardgamebuddy_bgg_pending_imports").upsert(
        _pending_payload(user_id, bgg_id, kind, payload),
        on_conflict="user_id,bgg_id,kind",
    ).execute()


def _pending_payload(user_id: str, bgg_id: int, kind: str, payload: dict) -> dict:
    """The row _queue_pending writes. Shared with the batch path."""
    return {
        "user_id": user_id,
        "bgg_id": bgg_id,
        "kind": kind,
        "payload": payload,
        "status": "pending",
        "attempts": 0,
        "error_message": None,
        "completed_at": None,
    }


# ── Batched sync writers ─────────────────────────────────────────────────────
# A first sync used to write one row at a time: one upsert per collection game,
# and per play a dedup SELECT, an INSERT, then one INSERT per player. A
# 300-game / 800-play / 4-player account came to roughly 5,100 sequential
# PostgREST calls in a single request — and because the Supabase client is
# synchronous, every one of them blocked the worker's event loop for every
# other user of the backend, not just for the syncing one.
#
# These write the same rows in a handful of statements. play_routes'
# _write_play_players already did exactly this for the log-a-play path; the
# BGG path simply never got the same treatment.

# Chunk size for bulk writes and for `in_` filters. PostgREST puts filters in
# the query string, so an unchunked `in_` over a few thousand ids is a
# multi-kilobyte URL that eventually trips a 414.
_BATCH = 500


def _chunked(seq: list, size: int = _BATCH):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _upsert_collection_rows(sb: Client, user_id: str, items: list[tuple]) -> int:
    """Bulk-upsert collection rows. `items` is [(game_row, status, private)]."""
    held = _prev_owned_game_ids(sb, user_id) if items else set()
    rows = [_collection_payload(
                user_id, game, _hold_prev_owned(status, held, game["id"]), private)
            for game, status, private in items]
    if not rows:
        return 0
    # Later duplicates win, matching the per-row loop's last-write-wins order.
    # Doing this here rather than in the DB keeps one statement per chunk:
    # Postgres rejects an ON CONFLICT batch that hits the same key twice.
    deduped = {(r["user_id"], r["game_id"]): r for r in rows}
    for chunk in _chunked(list(deduped.values())):
        sb.table("boardgamebuddy_collections").upsert(
            chunk, on_conflict="user_id,game_id"
        ).execute()
    return len(rows)


def _queue_pending_rows(sb: Client, user_id: str, items: list[tuple]) -> int:
    """Bulk-upsert pending-import rows. `items` is [(bgg_id, kind, payload)]."""
    rows = [_pending_payload(user_id, bgg_id, kind, payload)
            for bgg_id, kind, payload in items]
    if not rows:
        return 0
    deduped = {(r["user_id"], r["bgg_id"], r["kind"]): r for r in rows}
    for chunk in _chunked(list(deduped.values())):
        sb.table("boardgamebuddy_bgg_pending_imports").upsert(
            chunk, on_conflict="user_id,bgg_id,kind"
        ).execute()
    return len(rows)


def _materialize_plays(sb: Client, user_id: str, items: list[tuple]) -> None:
    """Bulk-insert plays + their players. `items` is [(game_row, play_payload)].

    Dedup is one batched SELECT against the partial UNIQUE on
    (user_id, bgg_play_id) (001_baseline.sql:169-171) instead of a probe per
    play. Rows the account already has are skipped without touching their
    players, exactly as the per-play path did.

    Plays with no bgg_play_id can't be matched back to their inserted id by
    key, so they fall through to the single-row path. BGG always supplies one,
    so this is a guard rather than a code path we expect to take.
    """
    keyed: dict[int, tuple] = {}
    unkeyed: list[tuple] = []
    for game, payload in items:
        bgg_play_id = payload.get("bgg_play_id")
        if bgg_play_id is None:
            unkeyed.append((game, payload))
        else:
            # BGG can repeat a play id across pages; last one wins.
            keyed[bgg_play_id] = (game, payload)

    for game, payload in unkeyed:
        _materialize_play(sb, user_id, game, payload)

    if not keyed:
        return

    already: set = set()
    for chunk in _chunked(sorted(keyed)):
        res = (
            sb.table("boardgamebuddy_plays")
            .select("bgg_play_id")
            .eq("user_id", user_id)
            .in_("bgg_play_id", chunk)
            .execute()
        )
        already.update(r["bgg_play_id"] for r in (res.data or []))

    fresh = [(bgg_play_id, keyed[bgg_play_id]) for bgg_play_id in sorted(keyed)
             if bgg_play_id not in already]
    if not fresh:
        return

    player_rows: list[dict] = []
    for chunk in _chunked(fresh):
        inserted = (
            sb.table("boardgamebuddy_plays")
            .insert([_play_row(user_id, game, payload) for _, (game, payload) in chunk])
            .execute()
        )
        # Map inserted ids back by bgg_play_id, NOT by array position —
        # Postgres does not promise INSERT ... RETURNING preserves input order.
        by_bgg = {r.get("bgg_play_id"): r["id"] for r in (inserted.data or [])}
        for bgg_play_id, (_game, payload) in chunk:
            play_id = by_bgg.get(bgg_play_id)
            if play_id is None:
                continue
            player_rows.extend(_player_rows(play_id, payload))

    for chunk in _chunked(player_rows):
        sb.table("boardgamebuddy_play_players").insert(chunk).execute()


# ── BGG XML parsing ──────────────────────────────────────────────────────────




def _parse_plays(body: str, *, username: str) -> tuple[list[dict], int]:
    """Parse a BGG /plays page into (rows, total).

    Each row: {bgg_play_id, bgg_id, played_at, notes, players[]}. `total` is the
    server-reported count so the caller knows when to stop paginating.
    """
    root = parse_bgg_xml(body, context=f"plays user={username!r}")
    try:
        total = int(root.get("total", "0"))
    except (TypeError, ValueError):
        total = 0

    rows: list[dict] = []
    for play_el in root.findall("play"):
        try:
            bgg_play_id = int(play_el.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_play_id:
            continue

        played_at = play_el.get("date") or None
        # BGG sometimes returns date="" for incomplete plays — skip those.
        if not played_at:
            continue

        item_el = play_el.find("item")
        if item_el is None:
            continue
        try:
            bgg_id = int(item_el.get("objectid", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_id:
            continue

        comments_el = play_el.find("comments")
        notes = comments_el.text if comments_el is not None else None

        players: list[dict] = []
        players_el = play_el.find("players")
        if players_el is not None:
            for p in players_el.findall("player"):
                name = (p.get("name") or "").strip()
                if not name:
                    continue
                players.append({
                    "name": name,
                    "is_winner": p.get("win") == "1",
                })

        rows.append({
            "bgg_play_id": bgg_play_id,
            "bgg_id": bgg_id,
            "played_at": played_at,
            "notes": notes,
            "players": players,
        })
    return rows, total


# ── Worker ───────────────────────────────────────────────────────────────────


async def _process_pending_imports(user_id: str) -> None:
    """Drain pending imports for one user, importing each missing game once.

    Runs as a FastAPI BackgroundTask. State lives in the DB so a process
    restart is safe — the next call to /bgg/sync picks up where we left off.
    """
    sb = get_supabase()

    while True:
        pending = (
            sb.table("boardgamebuddy_bgg_pending_imports")
            .select("id, bgg_id, kind, payload, attempts")
            .eq("user_id", user_id)
            .eq("status", "pending")
            .order("created_at")
            .limit(_WORKER_BATCH_SIZE)
            .execute()
        )
        rows = pending.data or []
        if not rows:
            return

        # Group all pending rows by bgg_id so we only call BGG once per game.
        by_bgg: dict[int, list[dict]] = {}
        for row in rows:
            by_bgg.setdefault(row["bgg_id"], []).append(row)

        for bgg_id, group in by_bgg.items():
            try:
                game_row = await import_game_from_bgg(sb, bgg_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "BGG worker: import failed user=%s bgg_id=%s: %s",
                    user_id, bgg_id, exc,
                )
                for row in group:
                    attempts = (row.get("attempts") or 0) + 1
                    next_status = "error" if attempts >= _WORKER_MAX_ATTEMPTS else "pending"
                    sb.table("boardgamebuddy_bgg_pending_imports").update({
                        "attempts": attempts,
                        "status": next_status,
                        "error_message": str(exc)[:500],
                        "completed_at": datetime.now(timezone.utc).isoformat()
                        if next_status == "error" else None,
                    }).eq("id", row["id"]).execute()
                await asyncio.sleep(_WORKER_THROTTLE_SECONDS)
                continue

            # Materialize the whole group in bulk first. A single unimported
            # game can carry dozens of pending play rows — one per logged play
            # — and writing those one at a time is the same N+1 the first-sync
            # path had. On any failure we fall back to the per-row loop below,
            # so one bad row still fails alone instead of failing its group.
            group_done = False
            try:
                _upsert_collection_rows(sb, user_id, [
                    (game_row, r["payload"]["status"], r["payload"].get("private"))
                    for r in group if r["kind"] == "collection"
                ])
                _materialize_plays(sb, user_id, [
                    (game_row, r["payload"]) for r in group if r["kind"] == "play"
                ])
                for chunk in _chunked([r["id"] for r in group]):
                    sb.table("boardgamebuddy_bgg_pending_imports").update({
                        "status": "done",
                        "error_message": None,
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                    }).in_("id", chunk).execute()
                group_done = True
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "BGG worker: bulk materialize failed user=%s bgg_id=%s, "
                    "retrying row-by-row: %s", user_id, bgg_id, exc,
                )

            if group_done:
                await asyncio.sleep(_WORKER_THROTTLE_SECONDS)
                continue

            # Per-row fallback. Both writers are idempotent — collections
            # upsert on (user_id, game_id) and plays dedup on bgg_play_id — so
            # replaying rows the bulk attempt already landed is safe.
            for row in group:
                try:
                    if row["kind"] == "collection":
                        _upsert_collection_row(
                            sb,
                            user_id,
                            game_row,
                            row["payload"]["status"],
                            row["payload"].get("private"),
                        )
                    elif row["kind"] == "play":
                        _materialize_play(sb, user_id, game_row, row["payload"])
                    sb.table("boardgamebuddy_bgg_pending_imports").update({
                        "status": "done",
                        "error_message": None,
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                    }).eq("id", row["id"]).execute()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "BGG worker: materialize failed user=%s bgg_id=%s kind=%s: %s",
                        user_id, bgg_id, row["kind"], exc,
                    )
                    attempts = (row.get("attempts") or 0) + 1
                    next_status = "error" if attempts >= _WORKER_MAX_ATTEMPTS else "pending"
                    sb.table("boardgamebuddy_bgg_pending_imports").update({
                        "attempts": attempts,
                        "status": next_status,
                        "error_message": str(exc)[:500],
                        "completed_at": datetime.now(timezone.utc).isoformat()
                        if next_status == "error" else None,
                    }).eq("id", row["id"]).execute()

            await asyncio.sleep(_WORKER_THROTTLE_SECONDS)


# ── Sync core ────────────────────────────────────────────────────────────────




async def _fetch_all_plays(user_id: str, username: str) -> list[dict]:
    """Pull every page of /plays for a user (BGG returns 100 per page).

    Uses cookie auth so private plays — and any future write actions — are
    available, mirroring the collection sync.
    """
    page = 1
    out: list[dict] = []
    while True:
        body = await fetch_bgg_as_user(
            user_id,
            "/plays",
            {"username": username, "page": page},
            timeout=20.0,
        )
        rows, total = _parse_plays(body, username=username)
        out.extend(rows)
        # Stop when we've collected all of them or the page returned nothing.
        if not rows or len(out) >= total:
            return out
        page += 1
        # Safety cap: BGG accounts rarely exceed a few thousand plays. 50 pages
        # = 5000 plays; beyond that we bail to avoid runaway loops on malformed
        # responses.
        if page > 50:
            return out


async def _run_sync(
    user_id: str,
    username: str,
    *,
    swept_items: Optional[list[BggCollectionItem]] = None,
) -> BggSyncSummary:
    """Pull collection + plays from BGG, materialize knowns, queue unknowns.

    `swept_items` is a collection read a comparison already made, handed over so
    the import does not spend eight throttled requests re-reading what it was
    just shown (services/bgg_check_cache.py). Only the collection half is ever
    reusable — a check never touches /plays, and quietly skipping those would
    turn "Import from BoardGameGeek" into "import some of it".
    """
    sb = get_supabase()

    # Stamp the start of this sync on the profile BEFORE we fetch anything.
    # GET /bgg/sync/status filters pending-import rows by created_at >= this
    # timestamp to compute session-scoped progress totals. The FE polls that
    # endpoint to drive an "Imported X of Y" progress bar.
    sync_started_at = datetime.now(timezone.utc)
    # Every Supabase call here is the SYNCHRONOUS client, so anything not
    # pushed to a thread blocks the worker's event loop for every other
    # in-flight request — see bootstrap_routes.py:56-63.
    await asyncio.to_thread(
        lambda: sb.table("boardgamebuddy_profiles").update(
            {"bgg_last_sync_started_at": sync_started_at.isoformat()}
        ).eq("id", user_id).execute()
    )

    if swept_items is not None:
        # A sweep is only ever handed over whole and clean — bgg_check_cache
        # refuses to pass on one that exhausted its warm-up retries — so there
        # is no partial read to flag here.
        collection_rows, coll_warm_up = collection_rows_from_items(swept_items), False
        logger.info(
            "BGG import: reusing a comparison's sweep of %d games for user=%s",
            len(collection_rows), user_id,
        )
    else:
        collection_rows, coll_warm_up = await _fetch_collection_batched(user_id, username)

    plays_warm_up = False
    try:
        play_rows = await _fetch_all_plays(user_id, username)
    except BggWarmUpError:
        logger.warning("BGG plays fetch warm-up exhausted user=%s", user_id)
        play_rows = []
        plays_warm_up = True

    # Resolve known bgg_ids in two batched queries.
    all_bgg_ids = {bid for bid, _, _ in collection_rows} | {p["bgg_id"] for p in play_rows}
    known = await asyncio.to_thread(_existing_game_map, sb, sorted(all_bgg_ids))

    # Sort each row into "we know this game" or "queue it for the worker",
    # then write each bucket in bulk. The per-row loops this replaces cost one
    # round trip per collection game and 2+players per play.
    coll_known: list[tuple] = []
    pending: list[tuple] = []
    for bgg_id, status, private in collection_rows:
        game_row = known.get(bgg_id)
        if game_row is not None:
            coll_known.append((game_row, status, private))
        else:
            pending.append((bgg_id, "collection", {"status": status, "private": private}))

    plays_known: list[tuple] = []
    for play in play_rows:
        bgg_id = play["bgg_id"]
        play_payload = {
            "bgg_play_id": play["bgg_play_id"],
            "played_at": play["played_at"],
            "notes": play.get("notes"),
            "players": play.get("players") or [],
        }
        game_row = known.get(bgg_id)
        if game_row is not None:
            plays_known.append((game_row, play_payload))
        else:
            pending.append((bgg_id, "play", play_payload))

    # Counts stay row-based, not statement-based, so the summary the FE renders
    # means the same thing it did before.
    coll_imported = len(coll_known)
    plays_imported = len(plays_known)
    coll_pending = sum(1 for _, kind, _ in pending if kind == "collection")
    plays_pending = sum(1 for _, kind, _ in pending if kind == "play")

    def _apply_writes() -> None:
        _upsert_collection_rows(sb, user_id, coll_known)
        _materialize_plays(sb, user_id, plays_known)
        _queue_pending_rows(sb, user_id, pending)

    await asyncio.to_thread(_apply_writes)

    total = coll_imported + coll_pending + plays_imported + plays_pending
    warm_up_retry_pending = (coll_warm_up or plays_warm_up) and total == 0

    # Distinct BGG ids queued for the worker — one /thing fetch per id, so
    # this is the meaningful "Y" in the FE's "Importing X of Y games" UI.
    # Collection + play rows can both reference the same missing game, so
    # naively adding the two pending counts inflates the apparent work.
    unique_to_import = len({bid for bid, _, _ in collection_rows if bid not in known} |
                            {p["bgg_id"] for p in play_rows if p["bgg_id"] not in known})

    return BggSyncSummary(
        bgg_username=username,
        collection_imported=coll_imported,
        collection_pending=coll_pending,
        plays_imported=plays_imported,
        plays_pending=plays_pending,
        unique_games_to_import=unique_to_import,
        warm_up_retry_pending=warm_up_retry_pending,
    )


# ── Routes ───────────────────────────────────────────────────────────────────


@router.post(
    "/bgg/link",
    response_model=BggLinkResponse,
    status_code=200,
    summary="Link a BoardGameGeek account (username + password)",
)
async def link_bgg(
    body: BggLinkBody,
    user: CurrentUser = Depends(get_current_user),
) -> BggLinkResponse:
    """Authenticate against BGG, then store the username + encrypted password.

    A successful login is also our existence check — BGG returns 401 for
    unknown accounts and bad passwords alike, which we surface as a 400. On
    success we keep the SessionID + cookies so subsequent xmlapi2 calls can
    be made AS this user (unlocking showprivate=1 and future write actions).
    """
    sb = get_supabase()
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    plain_password = body.password.get_secret_value()
    session = await login_to_bgg(username, plain_password)
    store_user_credentials(sb, user.user_id, username, plain_password, session)

    return BggLinkResponse(bgg_username=username)


@router.delete(
    "/bgg/link",
    response_model=BggLinkResponse,
    status_code=200,
    summary="Unlink the BoardGameGeek account",
)
async def unlink_bgg(
    user: CurrentUser = Depends(get_current_user),
) -> BggLinkResponse:
    """Clear all BGG credentials/cookies. Imported games and plays stay."""
    sb = get_supabase()
    clear_user_session(sb, user.user_id)
    return BggLinkResponse(bgg_username=None)


def _require_linked_username(sb: Client, user_id: str) -> str:
    """Read the linked BGG handle off the profile.

    Returns 400 when nothing is linked. Returns 409 ("re-link required") when
    the username is set but no encrypted password exists — i.e. a legacy
    public-only link from before per-user auth was added.
    """
    row = (
        sb.table("boardgamebuddy_profiles")
        .select("bgg_username, bgg_password_enc")
        .eq("id", user_id)
        .execute()
    )
    profile = (row.data or [None])[0]
    if not profile or not profile.get("bgg_username"):
        raise HTTPException(
            status_code=400,
            detail="No BoardGameGeek account linked. Link one first.",
        )
    if not profile.get("bgg_password_enc"):
        raise HTTPException(
            status_code=409,
            detail="BGG re-link required: please re-enter your BGG password.",
        )
    return profile["bgg_username"]


@router.post(
    "/bgg/sync",
    response_model=BggSyncSummary,
    status_code=200,
    summary="Sync collection + plays from BGG",
)
async def sync_bgg(
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> BggSyncSummary:
    """Pull the linked BGG account's collection and plays.

    Games already in our catalog are written immediately. Games we don't have
    yet are persisted as pending imports and a background task drains them
    after fetching each missing game from BGG (one BGG call per unique game,
    ~1.5s apart).
    """
    sb = get_supabase()
    username = _require_linked_username(sb, user.user_id)

    # Both directions drive the same BGG session, and an import landing
    # mid-push would overwrite shelf rows the queued plan was computed from.
    # Enforced here, not only in the UI: two tabs, two devices.
    push_state = sb.rpc("bgb_bgg_push_status", {"p_user": user.user_id}).execute().data or {}
    if int(push_state.get("pending_count") or 0):
        raise HTTPException(
            status_code=409,
            detail="A BoardGameGeek push is still running. Wait for it to finish, then try again.",
        )

    # The comparison the user just reviewed read this exact collection, at most
    # five minutes ago. Taking that read rather than repeating it is the whole
    # difference between pressing Import and watching the same forty-second
    # sweep a second time.
    summary = await _run_sync(
        user.user_id, username,
        swept_items=bgg_check_cache.pop_sweep(user.user_id),
    )

    # Schedule the worker to drain any missing-game queue we just created
    # plus any leftovers from a previous sync.
    background_tasks.add_task(_process_pending_imports, user.user_id)

    return summary




@router.get(
    "/bgg/sync/status",
    response_model=BggSyncStatus,
    status_code=200,
    summary="BGG sync status (linked username + auth state + queue counts)",
)
async def get_sync_status(
    user: CurrentUser = Depends(get_current_user),
) -> BggSyncStatus:
    """Return linked username, auth_state, and pending/errored counts for FE polling."""
    sb = get_supabase()

    # Single RPC (migration 039) — this endpoint is POLLED by the FE for the
    # whole duration of an import and previously cost up to 7 round trips
    # per poll (profile + two counts + last-done + session roll-up + name
    # resolution). The SQL mirrors the old per-bgg_id precedence exactly
    # (pending wins over error wins over done).
    data = (
        sb.rpc("bgb_bgg_sync_status", {"p_user": user.user_id})
        .execute()
        .data
        or {}
    )
    bgg_username = data.get("bgg_username")
    if not bgg_username:
        auth_state = BggAuthState.UNLINKED
    elif data.get("has_credentials"):
        auth_state = BggAuthState.LINKED
    else:
        auth_state = BggAuthState.RELINK_REQUIRED

    return BggSyncStatus(
        bgg_username=bgg_username,
        auth_state=auth_state,
        pending_count=data.get("pending_count") or 0,
        errored_count=data.get("errored_count") or 0,
        last_completed_at=data.get("last_completed_at"),
        session_started_at=data.get("session_started_at"),
        session_total=data.get("session_total") or 0,
        session_done=data.get("session_done") or 0,
        session_errored=data.get("session_errored") or 0,
        session_game_names=data.get("session_game_names") or [],
        catalog_session_started_at=data.get("catalog_session_started_at"),
        catalog_session_total=data.get("catalog_session_total") or 0,
        catalog_session_done=data.get("catalog_session_done") or 0,
        catalog_session_errored=data.get("catalog_session_errored") or 0,
        catalog_session_game_names=data.get("catalog_session_game_names") or [],
    )
