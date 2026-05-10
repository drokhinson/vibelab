"""Shared external-API call logger.

Every outbound HTTP request to a third-party service (BoardGameGeek, Trefle,
Perenual, image CDNs, future APIs) is recorded in `public.api_logs` so the
admin dashboard can surface latency, errors, and response bodies.

Usage from a route package:

    import httpx
    from api_logger import log_external_call

    async with httpx.AsyncClient(timeout=8.0) as client:
        async with log_external_call(
            app="plant-planner", api_name="trefle",
            method="GET", url=url, params=params,
            redact_params=("token",),
        ) as record:
            resp = await client.get(url, params=params)
            record.attach_response(resp)

The context manager always commits a row on exit (success OR exception). DB
writes are scheduled on the running event loop so they don't block the user
request; logger failures are swallowed.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Iterable, Optional

import httpx

from db import get_supabase

logger = logging.getLogger(__name__)

# Cap the stored body so a single 1MB+ BGG /collection response doesn't blow up
# the table. Full size is recorded separately in response_size_bytes.
BODY_EXCERPT_BYTES = 8192
REDACTED = "***"

# A user's session is a stretch of activity bounded by 30 minutes of idle. The
# next call after that gap (or the first call from a fresh login) starts a new
# session row in public.api_sessions.
SESSION_IDLE_TIMEOUT = timedelta(minutes=30)

# Per-request user context. Populated by api_logger.set_request_user() (called
# from each app's get_current_user dependency); read by log_external_call when
# it writes the api_logs row.
_current_user: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "api_logger_current_user", default=None,
)
_current_user_label: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "api_logger_current_user_label", default=None,
)
_current_app: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "api_logger_current_app", default=None,
)
_current_session_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "api_logger_current_session_id", default=None,
)


def _resolve_or_create_session_sync(
    app: str, user_id: str, user_label: Optional[str],
) -> Optional[str]:
    """Return the active session id for (app, user_id), creating one if needed.

    Synchronous — call via asyncio.to_thread from set_request_user so the event
    loop isn't blocked.
    """
    sb = get_supabase()
    cutoff = (datetime.now(timezone.utc) - SESSION_IDLE_TIMEOUT).isoformat()
    existing = (
        sb.table("api_sessions")
        .select("id")
        .eq("app", app)
        .eq("user_id", user_id)
        .gte("last_activity_at", cutoff)
        .order("last_activity_at", desc=True)
        .limit(1)
        .execute()
    )
    if existing.data:
        return existing.data[0]["id"]
    try:
        new_row = (
            sb.table("api_sessions")
            .insert({"app": app, "user_id": user_id, "user_label": user_label})
            .execute()
        )
        return (new_row.data or [{}])[0].get("id")
    except Exception as exc:
        logger.warning("api_logger session create failed: %s", exc)
        return None


async def set_request_user(
    *, user_id: Optional[str], user_label: Optional[str], app: str,
) -> None:
    """Bind the current request's user context to the api_logger.

    Call once per request from the app's `get_current_user()` dependency, after
    the user has been authenticated. Subsequent log_external_call() rows in the
    same request will be tagged with the resolved session_id and user_id.

    For unauthenticated callers, do not call this — log rows will be written
    with NULL session_id / user_id.
    """
    _current_app.set(app)
    _current_user.set(user_id)
    _current_user_label.set(user_label)
    if user_id:
        sid = await asyncio.to_thread(
            _resolve_or_create_session_sync, app, user_id, user_label,
        )
        _current_session_id.set(sid)
    else:
        _current_session_id.set(None)


def _bump_session_activity_sync(session_id: str) -> None:
    """Touch last_activity_at + bump call_count on the given session row."""
    sb = get_supabase()
    try:
        # Read current count (Supabase REST has no atomic increment); the
        # window for a lost increment under concurrency is tiny and only
        # affects an admin display, not correctness.
        cur = sb.table("api_sessions").select("call_count").eq("id", session_id).execute()
        count = (cur.data or [{}])[0].get("call_count", 0) or 0
        sb.table("api_sessions").update({
            "last_activity_at": datetime.now(timezone.utc).isoformat(),
            "call_count": count + 1,
        }).eq("id", session_id).execute()
    except Exception as exc:
        logger.warning("api_logger session bump failed: %s", exc)


@dataclass
class CallRecord:
    """Mutable record filled in by the caller while inside log_external_call().

    The caller must invoke `attach_response(resp)` after a successful HTTP call
    so the row records status_code / size / body. If an exception escapes the
    block, the context manager fills error_message from the exception text.
    """
    app: str
    api_name: str
    method: str
    url: str
    request_params: Optional[dict[str, Any]] = None
    status_code: Optional[int] = None
    response_size_bytes: Optional[int] = None
    body_excerpt: Optional[str] = None
    error_message: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)

    def attach_response(self, resp: httpx.Response) -> None:
        """Capture status, size, and a truncated body from an httpx Response."""
        self.status_code = resp.status_code
        # resp.content is bytes; len() is the on-the-wire size.
        try:
            self.response_size_bytes = len(resp.content)
        except Exception:
            self.response_size_bytes = None
        try:
            text = resp.text
        except Exception:
            text = None
        if text is not None:
            self.body_excerpt = text[:BODY_EXCERPT_BYTES]


def _redact(params: Optional[dict[str, Any]], redact_keys: Iterable[str]) -> Optional[dict[str, Any]]:
    if not params:
        return None
    keys = set(redact_keys)
    return {k: (REDACTED if k in keys else v) for k, v in params.items()}


def _truncate_url(url: str) -> str:
    # Keep the path but drop overly long query strings (some APIs put long
    # base64 in query). The unredacted params are stored separately.
    if len(url) <= 2000:
        return url
    return url[:2000] + "...[truncated]"


def _insert_row(row: dict[str, Any]) -> None:
    """Synchronous insert used by the background task wrapper."""
    try:
        get_supabase().table("api_logs").insert(row).execute()
    except Exception as exc:
        # NEVER let a logging failure surface to the caller — just complain in
        # the server log and move on.
        logger.warning("api_logger insert failed: %s", exc)


async def _async_insert(row: dict[str, Any], session_id: Optional[str]) -> None:
    try:
        await asyncio.to_thread(_insert_row, row)
        if session_id:
            await asyncio.to_thread(_bump_session_activity_sync, session_id)
    except Exception as exc:
        logger.warning("api_logger async insert failed: %s", exc)


def _schedule_insert(row: dict[str, Any], session_id: Optional[str]) -> None:
    """Fire-and-forget the DB write so the caller's request doesn't wait on it."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(_async_insert(row, session_id))
    else:
        # Sync caller (rare in this codebase) — fall back to a blocking write.
        _insert_row(row)
        if session_id:
            _bump_session_activity_sync(session_id)


@asynccontextmanager
async def log_external_call(
    *,
    app: str,
    api_name: str,
    method: str = "GET",
    url: str,
    params: Optional[dict[str, Any]] = None,
    redact_params: Iterable[str] = (),
) -> AsyncIterator[CallRecord]:
    """Context manager that records a single external API call.

    On exit (normal or exception) writes one row to public.api_logs. The row's
    response_time_ms is computed from a monotonic clock at entry/exit. Any
    exception raised inside the block is re-raised after the row is recorded.
    """
    record = CallRecord(
        app=app,
        api_name=api_name,
        method=method,
        url=_truncate_url(url),
        request_params=_redact(params, redact_params),
    )
    start = time.monotonic()
    try:
        yield record
    except Exception as exc:
        record.error_message = f"{type(exc).__name__}: {exc}"[:1000]
        raise
    finally:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        session_id = _current_session_id.get()
        user_id = _current_user.get()
        row = {
            "app": record.app,
            "api_name": record.api_name,
            "method": record.method,
            "url": record.url,
            "request_params": record.request_params,
            "response_time_ms": elapsed_ms,
            "status_code": record.status_code,
            "response_size_bytes": record.response_size_bytes,
            "body_excerpt": record.body_excerpt,
            "error_message": record.error_message,
            "session_id": session_id,
            "user_id": user_id,
        }
        _schedule_insert(row, session_id)
