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
    PLAY_DENORM_GAME_FIELDS,
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

# Subtypes we sweep when batching the /collection request. Each (subtype,
# status) pair is its own xmlapi2 call so BGG can serve a smaller, more
# cacheable subset — large combined requests are what trigger the warm-up
# placeholder response that returns zero items.
_COLLECTION_SUBTYPES: tuple[str, ...] = ("boardgame", "boardgameexpansion")

# Throttle between BGG calls inside the worker. BGG's public limit is loose
# (a few req/sec) but they 429 aggressively if you blast them.
_WORKER_THROTTLE_SECONDS = 1.5
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
        .select("id, " + COLLECTION_DENORM_GAME_FIELDS + ", image_url")
        .in_("bgg_id", bgg_ids)
        .execute()
    )
    return {r["bgg_id"]: r for r in (rows.data or []) if r.get("bgg_id")}


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
    sb.table("boardgamebuddy_collections").upsert(
        payload,
        on_conflict="user_id,game_id",
    ).execute()


def _materialize_play(
    sb: Client,
    user_id: str,
    game: dict,
    play_payload: dict,
) -> None:
    """Insert a play + buddies + play_players from a BGG-derived payload.

    `game` is the full row returned by _existing_game_map or
    import_game_from_bgg; its denormalized fields land on the play row inline.

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
            "game_id": game["id"],
            "played_at": play_payload["played_at"],
            "notes": play_payload.get("notes"),
            "bgg_play_id": bgg_play_id,
            **play_denormalized_from_game(game),
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
        # Keep the legacy buddies roster populated (admin tools still read it)
        # but write the play_players row through the new columns from
        # migration 009 so we don't touch the dropped buddy_id (migration 013).
        sb.table("boardgamebuddy_buddies").upsert(
            {"owner_id": user_id, "name": name},
            on_conflict="owner_id,name",
        ).execute()
        sb.table("boardgamebuddy_play_players").insert({
            "play_id": play_id,
            "player_display_name": name,
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

            # Materialize each pending row for this game. game_row already
            # carries the denormalized fields we need to land on dependents.
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


def _status_priority(status: str) -> int:
    """Higher means stronger — used to pick a winner when one game shows up
    in multiple per-status batches (e.g. owned AND wishlisted)."""
    return {"owned": 2, "wishlist": 1}.get(status, 0)


def _merge_collection_row(
    existing: tuple[int, str, Optional[dict]],
    incoming: tuple[int, str, Optional[dict]],
) -> tuple[int, str, Optional[dict]]:
    bgg_id, ex_status, ex_private = existing
    _, in_status, in_private = incoming
    if _status_priority(in_status) > _status_priority(ex_status):
        ex_status = in_status
    if in_private is not None:
        if ex_private is None:
            ex_private = in_private
        else:
            merged = dict(ex_private)
            for key, value in in_private.items():
                if value is not None:
                    merged[key] = value
            ex_private = merged
    return (bgg_id, ex_status, ex_private)


async def _fetch_collection_batched(
    user_id: str, username: str,
) -> tuple[list[tuple[int, str, Optional[dict]]], bool]:
    """Pull the linked user's collection as N small (subtype, status) requests.

    BGG's xmlapi2 has no page/limit pagination on /collection; the only way
    to subdivide a huge collection so each request is small enough to be
    served from cache (rather than triggering the warm-up placeholder) is to
    filter by subtype and a single status flag at a time. We sweep the
    matrix _COLLECTION_SUBTYPES × _BGG_STATUSES and dedupe the results.

    Returns (rows, warm_up_failed). `warm_up_failed` is True iff at least one
    batch exhausted its warm-up retries — _run_sync uses it together with the
    final imported+pending counts to decide whether to surface a "try again"
    flag to the FE.
    """
    merged: dict[int, tuple[int, str, Optional[dict]]] = {}
    warm_up_failed = False
    first = True
    for subtype in _COLLECTION_SUBTYPES:
        for status_flag in _BGG_STATUSES.keys():
            if not first:
                await asyncio.sleep(_WORKER_THROTTLE_SECONDS)
            first = False
            params = {
                "username": username,
                status_flag: 1,
                "subtype": subtype,
                "stats": 1,
                "showprivate": 1,
            }
            try:
                body = await fetch_bgg_as_user(
                    user_id, "/collection", params, timeout=20.0,
                )
            except BggWarmUpError:
                logger.warning(
                    "BGG collection batch warm-up exhausted user=%s subtype=%s status=%s",
                    user_id, subtype, status_flag,
                )
                warm_up_failed = True
                continue
            for row in _parse_collection(body, username=username):
                bgg_id = row[0]
                if bgg_id in merged:
                    merged[bgg_id] = _merge_collection_row(merged[bgg_id], row)
                else:
                    merged[bgg_id] = row
    return list(merged.values()), warm_up_failed


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

    # Stamp the start of this sync on the profile BEFORE we fetch anything.
    # GET /bgg/sync/status filters pending-import rows by created_at >= this
    # timestamp to compute session-scoped progress totals. The FE polls that
    # endpoint to drive an "Imported X of Y" progress bar.
    sync_started_at = datetime.now(timezone.utc)
    sb.table("boardgamebuddy_profiles").update(
        {"bgg_last_sync_started_at": sync_started_at.isoformat()}
    ).eq("id", user_id).execute()

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
    known = _existing_game_map(sb, sorted(all_bgg_ids))

    # Materialize collection.
    coll_imported = 0
    coll_pending = 0
    for bgg_id, status, private in collection_rows:
        game_row = known.get(bgg_id)
        if game_row is not None:
            _upsert_collection_row(sb, user_id, game_row, status, private)
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
        game_row = known.get(bgg_id)
        if game_row is not None:
            _materialize_play(sb, user_id, game_row, play_payload)
            plays_imported += 1
        else:
            _queue_pending(sb, user_id, bgg_id, "play", play_payload)
            plays_pending += 1

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
    )
