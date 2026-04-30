"""BoardGameGeek account linking + collection/plays import.

Flow:
  1. User links a BGG username (POST /bgg/link), stored on their profile.
  2. POST /bgg/sync fetches the user's collection and plays from BGG's public
     XMLAPI (no API key required for read-only user data).
  3. Rows referencing games we already have are upserted immediately.
  4. Rows referencing games we don't have are persisted as pending imports;
     a BackgroundTask drains the queue by calling import_game_from_bgg() and
     materializing the deferred collection / play rows.
  5. The FE polls GET /bgg/sync/status until pending_count hits zero.

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
from .bgg_client import fetch_bgg, parse_bgg_xml
from .dependencies import CurrentUser, get_current_user
from .game_routes import import_game_from_bgg
from .models import (
    BggLinkBody,
    BggLinkResponse,
    BggSyncStatus,
    BggSyncSummary,
    MessageResponse,
)

logger = logging.getLogger(__name__)

# BGG-collection statuses we import. Anything else (prevowned, want, fortrade,
# preordered, …) is ignored for now; users can curate those flags on BGG and
# they won't pollute the BoardgameBuddy closet.
_BGG_STATUSES = {"own": "owned", "wishlist": "wishlist", "wanttoplay": "wishlist"}

# Throttle between BGG calls inside the worker. BGG's public limit is loose
# (a few req/sec) but they 429 aggressively if you blast them.
_WORKER_THROTTLE_SECONDS = 1.5
_WORKER_BATCH_SIZE = 50
_WORKER_MAX_ATTEMPTS = 3


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _bgg_user_exists(username: str) -> bool:
    """Verify the BGG account exists by looking up its numeric user id.

    BGG returns `<user id="0" ...>` for unknown handles and `<user id="<n>">`
    for real ones, so a non-zero id is our existence signal.
    """
    body = await fetch_bgg("/user", {"name": username}, timeout=10.0)
    root = parse_bgg_xml(body, context=f"user name={username!r}")
    user_id = root.get("id")
    try:
        return bool(user_id) and int(user_id) > 0
    except (TypeError, ValueError):
        return False


def _existing_game_map(sb: Client, bgg_ids: list[int]) -> dict[int, str]:
    """Bulk-resolve {bgg_id → game_id} for games already in our catalog."""
    if not bgg_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_games")
        .select("id, bgg_id")
        .in_("bgg_id", bgg_ids)
        .execute()
    )
    return {r["bgg_id"]: r["id"] for r in (rows.data or []) if r.get("bgg_id")}


def _upsert_collection_row(sb: Client, user_id: str, game_id: str, status: str) -> None:
    """Upsert one collection row using the existing (user_id, game_id) UNIQUE."""
    sb.table("boardgamebuddy_collections").upsert(
        {"user_id": user_id, "game_id": game_id, "status": status},
        on_conflict="user_id,game_id",
    ).execute()


def _materialize_play(
    sb: Client,
    user_id: str,
    game_id: str,
    play_payload: dict,
) -> None:
    """Insert a play + buddies + play_players from a BGG-derived payload.

    Dedups on (user_id, bgg_play_id): if a row with this BGG play id already
    exists for this user we skip re-inserting and don't touch its buddies.
    Mirrors the buddy upsert pattern used by play_routes.log_play.
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
        .insert({
            "user_id": user_id,
            "game_id": game_id,
            "played_at": play_payload["played_at"],
            "notes": play_payload.get("notes"),
            "bgg_play_id": bgg_play_id,
        })
        .execute()
    )
    if not play_result.data:
        return
    play_id = play_result.data[0]["id"]

    for player in play_payload.get("players") or []:
        name = (player.get("name") or "").strip()
        if not name:
            continue
        buddy_result = (
            sb.table("boardgamebuddy_buddies")
            .upsert(
                {"owner_id": user_id, "name": name},
                on_conflict="owner_id,name",
            )
            .execute()
        )
        if not buddy_result.data:
            continue
        sb.table("boardgamebuddy_play_players").insert({
            "play_id": play_id,
            "buddy_id": buddy_result.data[0]["id"],
            "is_winner": bool(player.get("is_winner")),
        }).execute()


def _queue_pending(
    sb: Client,
    user_id: str,
    bgg_id: int,
    kind: str,
    payload: dict,
) -> None:
    """Queue a row for the background worker. Idempotent on (user, bgg_id, kind, status='pending')."""
    sb.table("boardgamebuddy_bgg_pending_imports").upsert(
        {
            "user_id": user_id,
            "bgg_id": bgg_id,
            "kind": kind,
            "payload": payload,
            "status": "pending",
            "attempts": 0,
            "error_message": None,
            "completed_at": None,
        },
        on_conflict="user_id,bgg_id,kind",
    ).execute()


# ── BGG XML parsing ──────────────────────────────────────────────────────────


def _derive_collection_status(item) -> Optional[str]:
    """Map a BGG <item><status .../></item> to our collection status, or None."""
    status_el = item.find("status")
    if status_el is None:
        return None
    # Priority: own > wishlist/wanttoplay (latter two collapse into 'wishlist').
    if status_el.get("own") == "1":
        return "owned"
    for flag, mapped in _BGG_STATUSES.items():
        if flag == "own":
            continue
        if status_el.get(flag) == "1":
            return mapped
    return None


def _parse_collection(body: str, *, username: str) -> list[tuple[int, str]]:
    """Parse a BGG /collection response into [(bgg_id, status), ...]."""
    root = parse_bgg_xml(body, context=f"collection user={username!r}")
    out: list[tuple[int, str]] = []
    for item in root.findall("item"):
        try:
            bgg_id = int(item.get("objectid", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_id:
            continue
        status = _derive_collection_status(item)
        if status is None:
            continue
        out.append((bgg_id, status))
    return out


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
    restart is safe — the next call to /bgg/sync (or the manual
    /bgg/sync/process-pending fallback) picks up where we left off.
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

            game_id = game_row["id"]

            # Materialize each pending row for this game.
            for row in group:
                try:
                    if row["kind"] == "collection":
                        _upsert_collection_row(
                            sb, user_id, game_id, row["payload"]["status"]
                        )
                    elif row["kind"] == "play":
                        _materialize_play(sb, user_id, game_id, row["payload"])
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


async def _fetch_collection(username: str) -> list[tuple[int, str]]:
    """Fetch + parse the user's BGG collection. Pulls own + wishlist + wanttoplay."""
    body = await fetch_bgg(
        "/collection",
        {
            "username": username,
            "own": 1,
            "wishlist": 1,
            "wanttoplay": 1,
            "stats": 1,
        },
        timeout=20.0,
    )
    return _parse_collection(body, username=username)


async def _fetch_all_plays(username: str) -> list[dict]:
    """Pull every page of /plays for a user (BGG returns 100 per page)."""
    page = 1
    out: list[dict] = []
    while True:
        body = await fetch_bgg(
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


async def _run_sync(user_id: str, username: str) -> BggSyncSummary:
    """Pull collection + plays from BGG, materialize knowns, queue unknowns."""
    sb = get_supabase()

    collection_rows = await _fetch_collection(username)
    play_rows = await _fetch_all_plays(username)

    # Resolve known bgg_ids in two batched queries.
    all_bgg_ids = {bid for bid, _ in collection_rows} | {p["bgg_id"] for p in play_rows}
    known = _existing_game_map(sb, sorted(all_bgg_ids))

    # Materialize collection.
    coll_imported = 0
    coll_pending = 0
    for bgg_id, status in collection_rows:
        if bgg_id in known:
            _upsert_collection_row(sb, user_id, known[bgg_id], status)
            coll_imported += 1
        else:
            _queue_pending(sb, user_id, bgg_id, "collection", {"status": status})
            coll_pending += 1

    # Materialize plays.
    plays_imported = 0
    plays_pending = 0
    for play in play_rows:
        bgg_id = play["bgg_id"]
        play_payload = {
            "bgg_play_id": play["bgg_play_id"],
            "played_at": play["played_at"],
            "notes": play.get("notes"),
            "players": play.get("players") or [],
        }
        if bgg_id in known:
            _materialize_play(sb, user_id, known[bgg_id], play_payload)
            plays_imported += 1
        else:
            _queue_pending(sb, user_id, bgg_id, "play", play_payload)
            plays_pending += 1

    return BggSyncSummary(
        bgg_username=username,
        collection_imported=coll_imported,
        collection_pending=coll_pending,
        plays_imported=plays_imported,
        plays_pending=plays_pending,
    )


# ── Routes ───────────────────────────────────────────────────────────────────


@router.post(
    "/bgg/link",
    response_model=BggLinkResponse,
    status_code=200,
    summary="Link a BoardGameGeek username",
)
async def link_bgg(
    body: BggLinkBody,
    user: CurrentUser = Depends(get_current_user),
) -> BggLinkResponse:
    """Verify the BGG account exists and store its handle on the profile."""
    sb = get_supabase()
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    if not await _bgg_user_exists(username):
        raise HTTPException(
            status_code=404,
            detail=f"BoardGameGeek account '{username}' not found.",
        )

    sb.table("boardgamebuddy_profiles").update(
        {"bgg_username": username}
    ).eq("id", user.user_id).execute()

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
    """Clear bgg_username on the profile. Imported data stays — it's normal BB data now."""
    sb = get_supabase()
    sb.table("boardgamebuddy_profiles").update(
        {"bgg_username": None}
    ).eq("id", user.user_id).execute()
    return BggLinkResponse(bgg_username=None)


def _require_linked_username(sb: Client, user_id: str) -> str:
    """Read the linked BGG handle off the profile, 400 if not linked."""
    row = (
        sb.table("boardgamebuddy_profiles")
        .select("bgg_username")
        .eq("id", user_id)
        .execute()
    )
    if not row.data or not row.data[0].get("bgg_username"):
        raise HTTPException(
            status_code=400,
            detail="No BoardGameGeek account linked. Link one first.",
        )
    return row.data[0]["bgg_username"]


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

    summary = await _run_sync(user.user_id, username)

    # Schedule the worker to drain any missing-game queue we just created
    # plus any leftovers from a previous sync.
    background_tasks.add_task(_process_pending_imports, user.user_id)

    return summary


@router.post(
    "/bgg/sync/process-pending",
    response_model=MessageResponse,
    status_code=200,
    summary="Drain pending BGG imports (manual fallback)",
)
async def process_pending(
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Manually trigger the pending-imports worker for the current user.

    Useful as a fallback when a previous sync's BackgroundTask was cut short
    by a process restart. Idempotent: state is in the DB so re-running just
    picks up the queue.
    """
    await _process_pending_imports(user.user_id)
    return MessageResponse(message="Pending imports processed")


@router.get(
    "/bgg/sync/status",
    response_model=BggSyncStatus,
    status_code=200,
    summary="BGG sync status (linked username + queue counts)",
)
async def get_sync_status(
    user: CurrentUser = Depends(get_current_user),
) -> BggSyncStatus:
    """Return linked BGG username and pending/errored counts for FE polling."""
    sb = get_supabase()

    profile = (
        sb.table("boardgamebuddy_profiles")
        .select("bgg_username")
        .eq("id", user.user_id)
        .execute()
    )
    bgg_username = (profile.data[0].get("bgg_username") if profile.data else None)

    pending_q = (
        sb.table("boardgamebuddy_bgg_pending_imports")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .eq("status", "pending")
        .execute()
    )
    errored_q = (
        sb.table("boardgamebuddy_bgg_pending_imports")
        .select("id", count="exact")
        .eq("user_id", user.user_id)
        .eq("status", "error")
        .execute()
    )

    last_q = (
        sb.table("boardgamebuddy_bgg_pending_imports")
        .select("completed_at")
        .eq("user_id", user.user_id)
        .eq("status", "done")
        .order("completed_at", desc=True)
        .limit(1)
        .execute()
    )
    last_completed_at = None
    if last_q.data and last_q.data[0].get("completed_at"):
        last_completed_at = last_q.data[0]["completed_at"]

    return BggSyncStatus(
        bgg_username=bgg_username,
        pending_count=pending_q.count or 0,
        errored_count=errored_q.count or 0,
        last_completed_at=last_completed_at,
    )
