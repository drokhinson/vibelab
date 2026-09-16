"""
main.py — BoardgameBuddy API.

One FastAPI app, one project router. Split out of the vibelab shared backend,
where this file registered nine routers and the middleware below had to work
out which app a request belonged to from its path prefix. With one app that
question has one answer, so the prefix map is gone and `APP_NAME` is a
constant — but everything else here is carried over deliberately. Each block
says why, because every one of them was added in response to something that
broke in production.
"""
import logging
import os
import time
from typing import Optional

import truststore
truststore.inject_into_ssl()  # OS cert store, not certifi — fixes corporate proxies

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from postgrest.exceptions import APIError
from dotenv import load_dotenv

from api_logger import log_self_call, set_request_user
from jwt_auth import get_current_supabase_user

import analytics_routes
import routes as boardgame_buddy

load_dotenv()

APP_NAME = "boardgame-buddy"

app = FastAPI(
    title="BoardgameBuddy API",
    version="1.0.0",
    description="Board game collection, play logging, and quick-reference guides.",
    docs_url="/docs",
    openapi_tags=[
        {"name": "boardgame_buddy", "description": "Collection, plays, buddies, sessions and reference guides"},
        {"name": "analytics", "description": "Event tracking"},
    ],
)


# ── CORS ──────────────────────────────────────────────────────────────────────
# Comma-separated, no trailing slash. Must list every origin the browser app
# is served from — during a host migration that means the old one AND the new
# one, or the first client on stale DNS gets an opaque "Failed to fetch".
_origins_env = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5500,http://127.0.0.1:5500")
allowed_origins = [o.strip() for o in _origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ── Response compression ──────────────────────────────────────────────────────
# /bootstrap is a profile bundle, a 20-card feed page, the play partners and a
# status map, and it gates first paint. Ordering: add_middleware PREPENDS, so
# with CORS added above and the @app.middleware("http") decorators below added
# after, the stack runs outer-to-inner as self-timing -> api-logger-context ->
# GZip -> CORS -> routes. CORS headers are therefore set inside the compressor
# and survive it, and Starlette's GZip APPENDS to Vary rather than replacing
# it, so a compressed response carries `Vary: Origin, Accept-Encoding` and
# stays correctly cacheable per-origin.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ── Supabase/PostgREST error handler ──────────────────────────────────────────
# A raw APIError (bad query, schema drift after a migration, RLS) is otherwise
# unhandled → Starlette's ServerErrorMiddleware returns a 500 that never passes
# back through CORSMiddleware, so the browser sees no CORS headers and reports
# an opaque "Failed to fetch" on EVERY page. Handling it here (the handler runs
# inside the exception middleware, i.e. *below* CORS) means the 500 carries CORS
# headers and the frontend shows a real error. Detail is logged server-side,
# never leaked to the client.
_log = logging.getLogger("bgbuddy")


@app.exception_handler(APIError)
async def _handle_supabase_api_error(request: Request, exc: APIError) -> JSONResponse:
    """Turn an unhandled Supabase error into a clean, CORS-bearing 500."""
    _log.error("Supabase APIError on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "A server error occurred. Please try again in a moment."},
    )


# ── api_logger user-context middleware ────────────────────────────────────────
# Attach the authenticated user to api_logger contextvars for EVERY request,
# not just routes that declare Depends(get_current_user). Without this, the
# anonymous-friendly routes (the public BGG catalog reads) emit api_logs rows
# with NULL user_id even when the caller's JWT identifies a real user.
@app.middleware("http")
async def attach_api_logger_user_context(request: Request, call_next):
    """Decode the request's JWT (if any) and bind the user to the api_logger."""
    authz = request.headers.get("authorization")
    if authz and request.url.path.startswith("/api/v1/"):
        try:
            # `request` is passed so the verified user lands on request.state,
            # where the route's own Depends(get_current_user) picks it up
            # instead of verifying the same token a second time. Two
            # verifications per request bought nothing but a second chance to
            # hit the blocking JWKS fetch.
            su_user = await get_current_supabase_user(request, authorization=authz)
            await set_request_user(
                user_id=su_user.sub,
                user_label=su_user.email or su_user.sub,
                app=APP_NAME,
            )
        except Exception:
            # Invalid / expired token, JWKS hiccup, etc — the log row falls back
            # to anonymous. Never let this fail the request. Nothing is stashed
            # on failure either, so the route's own dependency still verifies
            # for itself and returns the right status.
            pass
    return await call_next(request)


# ── Self-timing for the boot-critical reads ───────────────────────────────────
# These three are what a cold boot waits on, and nothing measured them: api_logs
# recorded only outbound third-party calls, so "how long does /bootstrap take,
# and how big is it?" could only be guessed at. That is the wrong footing from
# which to claim a load-time fix worked.
#
# An allowlist rather than every request, because api_logs is unbounded and a
# row per request would bury the third-party rows it exists for.
#
# Registered LAST and therefore OUTERMOST (add_middleware prepends), which is
# deliberate: outside GZip, so response_size_bytes is the compressed body
# actually put on the wire — the number that says whether the compression was
# worth adding. It also means this wraps the auth middleware, so the user is
# read off request.state (an object mutation, which propagates out of an inner
# BaseHTTPMiddleware) rather than from a contextvar (which does not).
_SELF_TIMED_SUFFIXES = ("/bootstrap", "/bootstrap/game-bundles", "/feed")


def _content_length(response) -> Optional[int]:
    try:
        return int(response.headers.get("content-length"))
    except (TypeError, ValueError):
        return None


@app.middleware("http")
async def time_boot_critical_requests(request: Request, call_next):
    """Record one api_logs row per request to a boot-critical endpoint."""
    path = request.url.path
    if not path.endswith(_SELF_TIMED_SUFFIXES):
        return await call_next(request)

    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        _log_self(request, path, start, 500, None)
        raise
    _log_self(request, path, start, response.status_code, _content_length(response))
    return response


def _log_self(request, path, start, status, size) -> None:
    """Write the row, never letting instrumentation break the request."""
    try:
        su_user = getattr(request.state, "supabase_user", None)
        log_self_call(
            app=APP_NAME,
            method=request.method,
            path=path,
            response_time_ms=int((time.monotonic() - start) * 1000),
            status_code=status,
            response_size_bytes=size,
            user_id=su_user.sub if su_user else None,
            user_label=(su_user.email or su_user.sub) if su_user else None,
        )
    except Exception:
        _log.warning("self-timing log failed for %s", path, exc_info=True)


# ── Health ────────────────────────────────────────────────────────────────────
# railway.toml's healthcheckPath points here. Keep the path stable.
@app.get("/api/v1/health", summary="Health check")
async def health():
    """Returns overall service status."""
    return {"status": "ok", "service": "bgbuddy"}


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(boardgame_buddy.router)
app.include_router(analytics_routes.router)
