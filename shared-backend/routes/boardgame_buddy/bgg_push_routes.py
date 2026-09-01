"""BgB -> BGG collection push, and the comparison both sync buttons act on.

Three routes:

  POST /bgg/check       Sweep the live BGG collection, diff it against the BgB
                        shelf, and fill catalog gaps. Writes nothing to BGG.
  POST /bgg/push        Re-plan server-side, queue every change, drain it in
                        the background.
  GET  /bgg/push/status One RPC; the FE polls this while the queue drains.

Neither sync is offered by the UI until a check has run, so no sync starts
against a state the user has not seen. The server enforces the parts that
matter regardless of the UI: /bgg/push re-plans rather than trusting the
client's list, refuses to run on a partial sweep, and 409s while an import is
in flight (and vice versa) because both workers drive the same BGG session.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import BackgroundTasks, Depends, HTTPException
from supabase import Client

from db import get_supabase

from . import router
from .bgg_link_routes import _require_linked_username
from .bgg_write import push_collection_status
from .constants import BggAuthState, BggPushChange
from .dependencies import CurrentUser, get_current_user
from .models import (
    BggDiffItem,
    BggDiffResponse,
    BggPullItem,
    BggPushBody,
    BggPushError,
    BggPushStatus,
    BggPushSummary,
    BggUnpushableItem,
)
from .services.bgg_compare_service import ComparePlan, build_plan

logger = logging.getLogger(__name__)

# Above the read path's 1.5s. BGG's write rate limits are undocumented, so this
# is tunable without a redeploy — watch the api_name="bgg-write" rows in
# api_logs for latency and 429s before changing it.
_PUSH_THROTTLE_SECONDS = float(os.getenv("BGG_PUSH_THROTTLE_SECONDS", "2.0"))
_PUSH_BATCH_SIZE = 25
_PUSH_MAX_ATTEMPTS = 3
_PUSH_RATE_LIMIT_BACKOFF = 30.0
_PUSH_MAX_BACKOFFS = 5
# The item lists are for a review sheet, not a data export. The push itself is
# uncapped — it re-plans server-side — so this only bounds the payload.
_MAX_LIST_ITEMS = 500


# ── Shared guards ────────────────────────────────────────────────────────────


def _pending_count(sb: Client, rpc: str, user_id: str) -> int:
    data = sb.rpc(rpc, {"p_user": user_id}).execute().data or {}
    return int(data.get("pending_count") or 0)


async def _reject_if_import_running(sb: Client, user_id: str) -> None:
    """Both workers drive the same BGG session; a plan built mid-import is junk."""
    if await asyncio.to_thread(_pending_count, sb, "bgb_bgg_sync_status", user_id):
        raise HTTPException(
            status_code=409,
            detail="A BoardGameGeek import is still running. Wait for it to finish, then try again.",
        )


async def _reject_if_push_running(sb: Client, user_id: str) -> None:
    if await asyncio.to_thread(_pending_count, sb, "bgb_bgg_push_status", user_id):
        raise HTTPException(
            status_code=409,
            detail="A BoardGameGeek push is still running. Wait for it to finish, then try again.",
        )


def _queue_catalog_imports(sb: Client, user_id: str, bgg_ids: list[int]) -> None:
    """Queue games BgB's catalog has never seen for a catalog-ONLY import.

    kind='catalog' materializes the game row and nothing else: the worker's
    bulk path filters on kind for its two writers, so a catalog row touches
    neither and is simply marked done once import_game_from_bgg succeeds.

    That restraint is the point. A shelf row here would stop the game reading
    as "only on BGG", and the push would silently stop offering to clear it.
    """
    if not bgg_ids:
        return
    rows = [{
        "user_id": user_id,
        "bgg_id": bgg_id,
        "kind": "catalog",
        "payload": {},
        "status": "pending",
        "attempts": 0,
        "error_message": None,
        "completed_at": None,
    } for bgg_id in bgg_ids]
    sb.table("boardgamebuddy_bgg_pending_imports").upsert(
        rows, on_conflict="user_id,bgg_id,kind",
    ).execute()


def _diff_response(username: str, plan: ComparePlan, catalog_pending: int) -> BggDiffResponse:
    push_items = [
        BggDiffItem(
            bgg_id=p.bgg_id, game_id=p.game_id, game_name=p.game_name,
            thumbnail_url=p.thumbnail_url, change=p.change,
            local_status=p.local_status, remote_status=p.remote_status,
            newly_catalogued=p.newly_catalogued,
        )
        for p in plan.push[:_MAX_LIST_ITEMS]
    ]
    pull_items = [
        BggPullItem(
            bgg_id=p.bgg_id, game_name=p.game_name, change=p.change,
            local_status=p.local_status, remote_status=p.remote_status,
        )
        for p in plan.pull[:_MAX_LIST_ITEMS]
    ]
    return BggDiffResponse(
        bgg_username=username,
        checked_at=datetime.now(timezone.utc),
        in_sync_count=plan.in_sync_count,
        local_total=plan.local_total,
        remote_total=plan.remote_total,
        push_total=len(plan.push),
        pull_total=len(plan.pull),
        push_changes=push_items,
        pull_changes=pull_items,
        unpushable=[BggUnpushableItem(**u) for u in plan.unpushable],
        truncated=len(plan.push) > _MAX_LIST_ITEMS or len(plan.pull) > _MAX_LIST_ITEMS,
        catalog_pending=catalog_pending,
        warm_up_retry_pending=plan.warm_up_failed,
    )


# ── Routes ───────────────────────────────────────────────────────────────────


@router.post(
    "/bgg/check",
    response_model=BggDiffResponse,
    status_code=200,
    summary="Compare the BoardgameBuddy shelf against the live BGG collection",
)
async def check_bgg(
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> BggDiffResponse:
    """Diff BgB against BoardGameGeek in both directions, filling catalog gaps."""
    sb = get_supabase()
    username = _require_linked_username(sb, user.user_id)
    await _reject_if_import_running(sb, user.user_id)
    await _reject_if_push_running(sb, user.user_id)

    plan = await build_plan(sb, user.user_id, username)

    # The only write this route makes, and it lands in the game catalog, never
    # on anyone's shelf.
    if plan.catalog_missing:
        await asyncio.to_thread(
            _queue_catalog_imports, sb, user.user_id, plan.catalog_missing,
        )
        from .bgg_link_routes import _process_pending_imports
        background_tasks.add_task(_process_pending_imports, user.user_id)

    return _diff_response(username, plan, len(plan.catalog_missing))


@router.post(
    "/bgg/push",
    response_model=BggPushSummary,
    status_code=200,
    summary="Push BoardgameBuddy collection statuses up to BoardGameGeek",
)
async def push_bgg(
    body: BggPushBody,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> BggPushSummary:
    """Re-plan the comparison, queue every change, and drain it in the background."""
    sb = get_supabase()
    username = _require_linked_username(sb, user.user_id)
    await _reject_if_import_running(sb, user.user_id)
    await _reject_if_push_running(sb, user.user_id)

    # Re-plan rather than trusting the client's list. Their view can be minutes
    # old, and a stale plan sent to a write endpoint on a third-party service
    # is the worst possible place to trust a cache.
    plan = await build_plan(sb, user.user_id, username)

    if plan.warm_up_failed:
        # A batch that exhausted its warm-up retries returned ZERO items, which
        # reads downstream as "not on BGG". Pushing that plan would clear flags
        # off games we simply failed to see.
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is still preparing your collection. Try again in ~30 seconds.",
        )

    started_at = datetime.now(timezone.utc)
    await asyncio.to_thread(_stamp_and_queue, sb, user.user_id, started_at, plan)

    if plan.push:
        background_tasks.add_task(_process_push_queue, user.user_id, username)

    counts = {c: sum(1 for p in plan.push if p.change == c) for c in BggPushChange}
    return BggPushSummary(
        bgg_username=username,
        queued=len(plan.push),
        adds=counts[BggPushChange.ADD],
        updates=counts[BggPushChange.UPDATE],
        clears=counts[BggPushChange.CLEAR],
        unpushable=len(plan.unpushable),
        plan_changed=_plan_moved(body.checked_at, plan),
    )


def _plan_moved(checked_at: Optional[datetime], plan: ComparePlan) -> bool:
    """Whether anything changed between the user's review and this re-plan.

    Only a hint for the FE's wording — the freshly-computed plan is what runs
    either way.
    """
    return checked_at is not None and bool(plan.warm_up_failed)


def _stamp_and_queue(
    sb: Client, user_id: str, started_at: datetime, plan: ComparePlan,
) -> None:
    """Stamp the session and replace the queue with this plan, in one pass."""
    sb.table("boardgamebuddy_profiles").update(
        {"bgg_last_push_started_at": started_at.isoformat()}
    ).eq("id", user_id).execute()

    # Drop anything left from an earlier plan: a row still pending from a run
    # the user abandoned describes a collection state that no longer exists.
    sb.table("boardgamebuddy_bgg_push_queue").delete().eq("user_id", user_id).execute()
    if not plan.push:
        return

    from .bgg_write import build_status_form

    rows = [{
        "user_id": user_id,
        "bgg_id": p.bgg_id,
        "game_name": p.game_name,
        "bgg_collid": p.collid,
        "change": p.change.value,
        "target_status": None if p.change == BggPushChange.CLEAR else p.local_status,
        # Frozen here, not recomputed per row in the worker: the worker must
        # never re-read BGG, and a shelf edit mid-push must not produce a
        # half-old, half-new write set.
        "payload": build_status_form(
            bgg_id=p.bgg_id,
            collid=p.collid,
            target_status=None if p.change == BggPushChange.CLEAR else p.local_status,
            raw_status=p.raw_status,
        ),
        "status": "pending",
        "attempts": 0,
    } for p in plan.push]

    for i in range(0, len(rows), 500):
        sb.table("boardgamebuddy_bgg_push_queue").upsert(
            rows[i:i + 500], on_conflict="user_id,bgg_id",
        ).execute()


@router.get(
    "/bgg/push/status",
    response_model=BggPushStatus,
    status_code=200,
    summary="BGG push queue status (session-scoped progress)",
)
async def get_push_status(
    user: CurrentUser = Depends(get_current_user),
) -> BggPushStatus:
    """Return auth state plus pending/done/errored counts for FE polling."""
    sb = get_supabase()
    data = sb.rpc("bgb_bgg_push_status", {"p_user": user.user_id}).execute().data or {}

    bgg_username = data.get("bgg_username")
    if not bgg_username:
        auth_state = BggAuthState.UNLINKED
    elif data.get("has_credentials"):
        auth_state = BggAuthState.LINKED
    else:
        auth_state = BggAuthState.RELINK_REQUIRED

    return BggPushStatus(
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
        session_errors=[BggPushError(**e) for e in (data.get("session_errors") or [])],
    )


# ── The worker ───────────────────────────────────────────────────────────────


def _claim_batch(sb: Client, user_id: str) -> list[dict]:
    return (
        sb.table("boardgamebuddy_bgg_push_queue")
        .select("id, bgg_id, game_name, bgg_collid, change, target_status, payload, attempts")
        .eq("user_id", user_id)
        .eq("status", "pending")
        .order("created_at")
        .limit(_PUSH_BATCH_SIZE)
        .execute()
    ).data or []


def _mark_done(sb: Client, row_id: str) -> None:
    sb.table("boardgamebuddy_bgg_push_queue").update({
        "status": "done",
        "error_message": None,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", row_id).execute()


def _mark_failure(sb: Client, row: dict, message: str) -> None:
    attempts = (row.get("attempts") or 0) + 1
    final = attempts >= _PUSH_MAX_ATTEMPTS
    sb.table("boardgamebuddy_bgg_push_queue").update({
        "attempts": attempts,
        "status": "error" if final else "pending",
        "error_message": message[:500],
        "completed_at": datetime.now(timezone.utc).isoformat() if final else None,
    }).eq("id", row["id"]).execute()


def _abort_remaining(sb: Client, user_id: str, message: str) -> None:
    """Fail every still-pending row at once. Used when the session is dead."""
    sb.table("boardgamebuddy_bgg_push_queue").update({
        "status": "error",
        "error_message": message[:500],
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("user_id", user_id).eq("status", "pending").execute()


async def _process_push_queue(user_id: str, username: str) -> None:
    """Drain the push queue for one user, one BGG write per throttle tick.

    Runs as a FastAPI BackgroundTask. State lives in the DB, so a process
    restart is safe — pressing the button again resumes rather than replaying
    writes that already landed.

    Differs from _process_pending_imports in four deliberate ways:

      * Every Supabase call goes through asyncio.to_thread. The import worker
        omits this and blocks the event loop for every other in-flight request;
        see the comment in _run_sync.
      * A 429 does NOT burn an attempt — it backs off and leaves the row
        pending, bounded so a rate-limited account cannot spin forever.
      * A 409 aborts the whole run. Every remaining row would fail identically,
        and hammering BGG's login endpoint with a dead password is how an
        account gets locked.
      * Rows are never re-planned. The frozen payload is what gets sent.
    """
    sb = get_supabase()
    backoffs = 0

    while True:
        rows = await asyncio.to_thread(_claim_batch, sb, user_id)
        if not rows:
            return

        for row in rows:
            payload = row.get("payload") or {}
            try:
                await push_collection_status(
                    user_id, username,
                    bgg_id=row["bgg_id"],
                    collid=row.get("bgg_collid"),
                    target_status=row.get("target_status"),
                    raw_status=payload,
                )
            except HTTPException as exc:
                if exc.status_code == 429:
                    backoffs += 1
                    if backoffs > _PUSH_MAX_BACKOFFS:
                        await asyncio.to_thread(
                            _abort_remaining, sb, user_id,
                            "BoardGameGeek kept rate-limiting us; stopped to avoid a lockout.",
                        )
                        return
                    logger.warning(
                        "BGG push: rate limited (backoff %d/%d) user=%s",
                        backoffs, _PUSH_MAX_BACKOFFS, user_id,
                    )
                    await asyncio.sleep(_PUSH_RATE_LIMIT_BACKOFF)
                    continue  # row stays pending, no attempt burned
                if exc.status_code == 409:
                    logger.warning("BGG push: session dead for user=%s; aborting run", user_id)
                    await asyncio.to_thread(_abort_remaining, sb, user_id, str(exc.detail))
                    return
                await asyncio.to_thread(_mark_failure, sb, row, str(exc.detail))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "BGG push failed user=%s bgg_id=%s: %s", user_id, row["bgg_id"], exc,
                )
                await asyncio.to_thread(_mark_failure, sb, row, str(exc))
            else:
                await asyncio.to_thread(_mark_done, sb, row["id"])

            await asyncio.sleep(_PUSH_THROTTLE_SECONDS)
