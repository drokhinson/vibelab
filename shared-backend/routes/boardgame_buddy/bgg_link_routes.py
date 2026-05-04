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
from .bgg_client import (
    clear_user_session,
    fetch_bgg_as_user,
    has_stored_credentials,
    parse_bgg_xml,
    store_user_credentials,
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


def _upsert_collection_row(
    sb: Client,
    user_id: str,
    game_id: str,
    status: str,
    private: Optional[dict] = None,
) -> None:
    """Upsert one collection row using the existing (user_id, game_id) UNIQUE.

    `private` is the dict produced by _parse_collection (private fields from
    BGG's <privateinfo>). Keys missing from BGG come through as None so
    re-syncing after BGG-side deletion still nulls our copy.
    """
    payload: dict = {"user_id": user_id, "game_id": game_id, "status": status}
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
    sb.table("boardgamebuddy_collections").upsert(
        payload,
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


def _parse_private_info(item) -> Optional[dict]:
    """Extract <privateinfo .../> attributes (only present with showprivate=1).

    Returns None when the element is absent — callers should treat that as
    "no private fields to write" rather than nulling existing rows.
    """
    pi = item.find("privateinfo")
    if pi is None:
        return None

    def _num(name: str) -> Optional[float]:
        val = pi.get(name)
        if val in (None, "", "0", "0.0", "0.00"):
            return None
        try:
            return float(val)
        except ValueError:
            return None

    def _int(name: str) -> Optional[int]:
        val = pi.get(name)
        if val in (None, "", "0"):
            return None
        try:
            return int(val)
        except ValueError:
            return None

    acq_date = pi.get("acquisitiondate") or None
    if acq_date == "0000-00-00":
        acq_date = None

    private_comment_el = pi.find("privatecomment")
    private_comment = (
        private_comment_el.text.strip()
        if private_comment_el is not None and private_comment_el.text
        else None
    )

    return {
        "private_comment": private_comment,
        "acquired_from": (pi.get("acquiredfrom") or None) or None,
        "acquisition_date": acq_date,
        "purchase_price": _num("pricepaid"),
        "purchase_currency": (pi.get("pricepaidcurrency") or None) or None,
        "inventory_location": (pi.get("inventorylocation") or None) or None,
        "quantity": _int("quantity"),
    }


def _parse_collection(body: str, *, username: str) -> list[tuple[int, str, Optional[dict]]]:
    """Parse a BGG /collection?showprivate=1 response.

    Returns a list of (bgg_id, status, private_fields_or_None). The third
    element is None for items that don't carry a <privateinfo> block (the
    response was unauthenticated or the user has no private data on them).
    """
    root = parse_bgg_xml(body, context=f"collection user={username!r}")
    out: list[tuple[int, str, Optional[dict]]] = []
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
        out.append((bgg_id, status, _parse_private_info(item)))
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
                            sb,
                            user_id,
                            game_id,
                            row["payload"]["status"],
                            row["payload"].get("private"),
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


async def _fetch_collection(
    user_id: str, username: str,
) -> list[tuple[int, str, Optional[dict]]]:
    """Fetch the linked user's collection authenticated as that user.

    `showprivate=1` is what makes <privateinfo> show up; it requires the
    request to be authenticated as the same BGG user, which fetch_bgg_as_user
    handles via the stored cookies.
    """
    body = await fetch_bgg_as_user(
        user_id,
        "/collection",
        {
            "username": username,
            "own": 1,
            "wishlist": 1,
            "wanttoplay": 1,
            "stats": 1,
            "showprivate": 1,
        },
        timeout=20.0,
    )
    return _parse_collection(body, username=username)


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


async def _run_sync(user_id: str, username: str) -> BggSyncSummary:
    """Pull collection + plays from BGG, materialize knowns, queue unknowns."""
    sb = get_supabase()

    collection_rows = await _fetch_collection(user_id, username)
    play_rows = await _fetch_all_plays(user_id, username)

    # Resolve known bgg_ids in two batched queries.
    all_bgg_ids = {bid for bid, _, _ in collection_rows} | {p["bgg_id"] for p in play_rows}
    known = _existing_game_map(sb, sorted(all_bgg_ids))

    # Materialize collection.
    coll_imported = 0
    coll_pending = 0
    for bgg_id, status, private in collection_rows:
        if bgg_id in known:
            _upsert_collection_row(sb, user_id, known[bgg_id], status, private)
            coll_imported += 1
        else:
            _queue_pending(
                sb, user_id, bgg_id, "collection",
                {"status": status, "private": private},
            )
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
    summary="BGG sync status (linked username + auth state + queue counts)",
)
async def get_sync_status(
    user: CurrentUser = Depends(get_current_user),
) -> BggSyncStatus:
    """Return linked username, auth_state, and pending/errored counts for FE polling."""
    sb = get_supabase()

    profile = (
        sb.table("boardgamebuddy_profiles")
        .select("bgg_username, bgg_password_enc")
        .eq("id", user.user_id)
        .execute()
    )
    profile_row = (profile.data or [None])[0] or {}
    bgg_username = profile_row.get("bgg_username")
    if not bgg_username:
        auth_state = BggAuthState.UNLINKED
    elif has_stored_credentials(profile_row):
        auth_state = BggAuthState.LINKED
    else:
        auth_state = BggAuthState.RELINK_REQUIRED

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
        auth_state=auth_state,
        pending_count=pending_q.count or 0,
        errored_count=errored_q.count or 0,
        last_completed_at=last_completed_at,
    )
