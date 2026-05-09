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
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterable, Optional

import httpx

from db import get_supabase

logger = logging.getLogger(__name__)

# Cap the stored body so a single 1MB+ BGG /collection response doesn't blow up
# the table. Full size is recorded separately in response_size_bytes.
BODY_EXCERPT_BYTES = 8192
REDACTED = "***"


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


async def _async_insert(row: dict[str, Any]) -> None:
    try:
        await asyncio.to_thread(_insert_row, row)
    except Exception as exc:
        logger.warning("api_logger async insert failed: %s", exc)


def _schedule_insert(row: dict[str, Any]) -> None:
    """Fire-and-forget the DB write so the caller's request doesn't wait on it."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(_async_insert(row))
    else:
        # Sync caller (rare in this codebase) — fall back to a blocking write.
        _insert_row(row)


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
        }
        _schedule_insert(row)
