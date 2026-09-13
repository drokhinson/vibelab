"""
db.py — Supabase client singleton for the shared vibelab backend.
ONE Supabase project serves ALL apps. Tables are app-prefixed (e.g. sauceboss_carbs).

The client that `get_supabase()` hands back differs from a stock `create_client`
in one way: its PostgREST session retries a round trip that died on the wire.
See `_RetryingTransport` for why that is not optional.
"""
import logging
import os
import re
import time

import httpx
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# ── Transport-level retry ─────────────────────────────────────────────────────
# postgrest-py talks to Supabase over ONE long-lived, HTTP/2, connection-pooling
# httpx.Client. Supabase's edge recycles those connections on its own schedule:
# it sends a GOAWAY (h2) or simply closes a keep-alive socket (h1.1) while the
# pool still considers the connection usable. The next request handed to that
# connection dies before a single response byte arrives, and httpx surfaces it
# as:
#
#   httpx.RemoteProtocolError: <ConnectionTerminated error_code:0, last_stream_id:3, ...>
#   httpx.RemoteProtocolError: Server disconnected
#
# Nothing retried it, and RemoteProtocolError is not a postgrest APIError, so it
# escaped main.py's APIError handler as an unhandled 500 — the browser saw an
# opaque failure on a read that would have succeeded a millisecond later. Seven
# of them landed in a two-minute window of ordinary BoardgameBuddy browsing
# (GET /plays/{id}, the /plays page RPC), each one a visible error on a healthy
# database.
#
# The fix belongs at the transport, not at 400-odd call sites: this is the one
# place that sees the request method AND the exception, which is what decides
# whether repeating the request is safe.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# A read may be repeated freely (3 attempts). A write may not, so it gets one
# extra attempt and only under the narrow condition in `_should_retry`.
_MAX_ATTEMPTS_SAFE = 3
_MAX_ATTEMPTS_UNSAFE = 2
_BACKOFF_SECONDS = (0.05, 0.25)

# "The server shut this connection down cleanly." h2 spells NO_ERROR as 0; the
# message is the str() of the underlying h2 event, so both renderings are
# matched. A graceful GOAWAY is the one protocol error that says something about
# whether the request RAN: the peer is refusing further streams, not abandoning
# one mid-flight, so nothing was applied and even a write may be repeated. Every
# other disconnect (notably h11's "Server disconnected", which arrives after the
# bytes went out) leaves that unknowable, and is retried for reads only.
_GRACEFUL_GOAWAY = re.compile(r"error_code:\s*(?:0\b|ErrorCodes\.NO_ERROR)")

# Failures where the request provably never left this process, whatever it was.
_NEVER_SENT = (httpx.ConnectError, httpx.ConnectTimeout)

# Failures worth a second look at all. Deliberately NOT here: ReadTimeout and
# WriteTimeout (the query is genuinely slow — repeating it doubles the load on a
# database that is already struggling) and PoolTimeout (the pool is saturated;
# queueing another attempt makes that worse).
_RETRYABLE = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.WriteError,
    httpx.CloseError,
    httpx.RemoteProtocolError,
)


def _should_retry(request: httpx.Request, exc: Exception) -> bool:
    """Whether repeating `request` after `exc` is both useful and safe."""
    if isinstance(exc, _NEVER_SENT):
        return True
    if not isinstance(exc, _RETRYABLE):
        return False
    if request.method in _SAFE_METHODS:
        return True
    # PostgREST sends every RPC as a POST — including the read-only ones like
    # bgb_plays_page, which is why "retry reads only" cannot be decided from the
    # method alone here. What it CAN decide is the opposite: a POST might be
    # bgb_log_play, so it is repeated only when the peer's own GOAWAY says the
    # stream was never processed.
    return isinstance(exc, httpx.RemoteProtocolError) and bool(
        _GRACEFUL_GOAWAY.search(str(exc))
    )


class _RetryingTransport(httpx.HTTPTransport):
    """httpx transport that repeats a round trip killed before its response."""

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        max_attempts = (
            _MAX_ATTEMPTS_SAFE
            if request.method in _SAFE_METHODS
            else _MAX_ATTEMPTS_UNSAFE
        )
        # Materialise the body up front: a retry re-sends `request.stream`, and
        # only an in-memory one can be read twice. postgrest always passes JSON
        # (bytes already), so this is a no-op there and insurance elsewhere.
        if max_attempts > 1:
            request.read()

        attempt = 1
        while True:
            try:
                return super().handle_request(request)
            except httpx.TransportError as exc:
                if attempt >= max_attempts or not _should_retry(request, exc):
                    raise
                logger.warning(
                    "Supabase %s %s died on the wire (%s: %s) — attempt %d/%d",
                    request.method,
                    request.url.path,
                    type(exc).__name__,
                    exc,
                    attempt,
                    max_attempts,
                )
                # Brief pause so the pool has retired the dead connection and
                # the retry opens a fresh one rather than racing onto the same
                # socket. Short enough to stay invisible inside a request.
                time.sleep(_BACKOFF_SECONDS[attempt - 1])
                attempt += 1


def _retrying_session(session: httpx.Client) -> httpx.Client:
    """A stand-in for postgrest's own session, same settings + the retry."""
    return httpx.Client(
        base_url=session.base_url,
        headers=session.headers,
        # postgrest-py's own defaults, restated because building the client
        # ourselves is the only way to choose its transport. The read budget
        # matches DEFAULT_POSTGREST_CLIENT_TIMEOUT; the connect budget is
        # tightened so a dead peer fails fast enough for the retry above to be
        # worth having.
        timeout=httpx.Timeout(120.0, connect=10.0),
        follow_redirects=True,
        transport=_RetryingTransport(http2=True),
    )


def _install_retrying_session(client: Client) -> None:
    """Swap postgrest's session for one that retries. Never fatal."""
    try:
        postgrest = client.postgrest  # lazy: builds the stock session
        stock = postgrest.session
        postgrest.session = _retrying_session(stock)
        stock.close()
    except Exception:  # pragma: no cover - defensive, a boot must never die here
        logger.warning(
            "Supabase retry transport not installed; falling back to "
            "postgrest-py defaults",
            exc_info=True,
        )


# Service role key bypasses Row Level Security — for backend use only.
# Never expose this key to the frontend or React Native app.
_client: Client | None = None


def get_supabase() -> Client:
    global _client
    if _client is None:
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        _install_retrying_session(_client)
    return _client
