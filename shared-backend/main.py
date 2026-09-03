"""
main.py — vibelab shared FastAPI backend
ONE service handles ALL projects. Each project registers its own router.
Routes are namespaced: /api/v1/{project}/...
"""
import logging
import os
import time
from typing import Optional

import truststore
truststore.inject_into_ssl()  # use OS certificate store instead of certifi bundle

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from postgrest.exceptions import APIError
from dotenv import load_dotenv

from api_logger import log_self_call, set_request_user
from jwt_auth import get_current_supabase_user
from routes.sauceboss.modifiers import load_modifier_registry
from routes.sauceboss.units import load_unit_registry

# Project routers
from routes import sauceboss
from routes import wealthmate
from routes import spotme
from routes import daywordplay
from routes import plant_planner
from routes import boardgame_buddy
from routes import travel_scrapbook
from routes import person

# Infrastructure routers
from routes import analytics
from routes import admin

load_dotenv()

app = FastAPI(
    title="vibelab API",
    version="1.0.0",
    description="Shared backend for the vibelab monorepo. Each project registers routes under /api/v1/{project}/.",
    docs_url="/docs",
    openapi_tags=[
        {"name": "sauceboss", "description": "SauceBoss — sauce/dressing/marinade discovery and recipe builder"},
        {"name": "wealthmate", "description": "WealthMate — household financial tracking and check-ins"},
        {"name": "spotme", "description": "SpotMe — hobby-based social matching"},
        {"name": "daywordplay", "description": "Day Word Play — daily word games with groups"},
        {"name": "plant_planner", "description": "Plant Planner — garden layout and companion planting"},
        {"name": "analytics", "description": "Cross-app analytics tracking"},
        {"name": "boardgame_buddy", "description": "BoardgameBuddy — board game collection, play logging, and quick-reference guides"},
        {"name": "travel_scrapbook", "description": "Travel Trove — save travel links to trips, AI-extract places, and plan optimized routes"},
        {"name": "person", "description": "David Rokhinson personal page — admin-editable travel trips and stops"},
        {"name": "admin", "description": "Admin dashboard and user management"},
    ],
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Set ALLOWED_ORIGINS in Railway to comma-separated Vercel URLs.
# React Native does not need CORS (not a browser origin).
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
# Every JSON response this service produced went over the wire uncompressed.
# That is worst on the read that gates a boot: boardgame-buddy's /bootstrap is a
# profile bundle, a 20-card feed page, the play partners and a status map over
# every owned game — highly repetitive JSON, which is exactly what deflate is
# good at. Applies to all ten apps, not just that one.
#
# minimum_size skips the small stuff, where the ~20-byte gzip header and the CPU
# are not worth it: a health check, a {"status": "ok"}, a CORS preflight's empty
# body.
#
# Ordering: add_middleware PREPENDS, so with CORS added above and the
# @app.middleware("http") decorator below added after, the stack runs
# outer-to-inner as api-logger-context -> GZip -> CORS -> routes. CORS headers
# are therefore set inside the compressor and survive it, and Starlette's GZip
# APPENDS to Vary rather than replacing it, so a compressed response carries
# `Vary: Origin, Accept-Encoding` and stays correctly cacheable per-origin.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ── Supabase/PostgREST error handler ──────────────────────────────────────────
# A raw APIError (bad query, schema drift after a migration, RLS, etc.) is
# otherwise unhandled → Starlette's ServerErrorMiddleware returns a 500 that
# never passes back through CORSMiddleware, so the browser sees no CORS headers
# and reports an opaque "Failed to fetch" on EVERY page. Handling it here (the
# handler runs inside the exception middleware, i.e. *below* CORS) means the 500
# carries CORS headers and the frontend shows a real error. Detail is logged
# server-side, never leaked to the client.
_log = logging.getLogger("vibelab")


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
# regardless of whether the route declares Depends(get_current_user). Without
# this, anonymous-friendly routes (plant-planner catalog/cache-fill, BGG public
# catalog) emit api_logs rows with NULL user_id even when the caller's JWT
# identifies a real user.
# Each prefix must match the router's real APIRouter prefix exactly — this is a
# startswith() match, so a hyphen here against an underscore prefix silently
# matches nothing and every request for that app logs an anonymous api_logs row.
_APP_PREFIX_MAP = [
    ("/api/v1/plant_planner/",    "plant-planner"),
    ("/api/v1/boardgame_buddy/",  "boardgame-buddy"),
    ("/api/v1/sauceboss/",        "sauceboss"),
    ("/api/v1/wealthmate/",       "wealthmate"),
    ("/api/v1/daywordplay/",      "daywordplay"),
    ("/api/v1/spotme/",           "spotme"),
    ("/api/v1/travel_scrapbook/", "travel-scrapbook"),
]


@app.middleware("http")
async def attach_api_logger_user_context(request: Request, call_next):
    """Decode the request's JWT (if any) and bind the user to the api_logger."""
    path = request.url.path
    app_name = next((name for prefix, name in _APP_PREFIX_MAP if path.startswith(prefix)), None)
    if app_name:
        authz = request.headers.get("authorization")
        if authz:
            try:
                # `request` is passed so the verified user lands on
                # request.state, where the route's own Depends(get_current_user)
                # picks it up instead of verifying the same token a second time.
                # Two verifications per request bought nothing but a second
                # chance to hit the blocking JWKS fetch.
                su_user = await get_current_supabase_user(request, authorization=authz)
                await set_request_user(
                    user_id=su_user.sub,
                    user_label=su_user.email or su_user.sub,
                    app=app_name,
                )
            except Exception:
                # Invalid / expired token, JWKS hiccup, etc — log row will fall
                # back to anonymous. Never let this fail the request. Nothing is
                # stashed on failure either, so the route's own dependency still
                # verifies for itself and returns the right status.
                pass
    return await call_next(request)


# ── Self-timing for the boot-critical reads ───────────────────────────────────
# These three are what a cold boot waits on, and nothing measured them: api_logs
# recorded only outbound third-party calls, so "how long does /bootstrap take,
# and how big is it?" could only be guessed at. That is the wrong footing from
# which to claim a load-time fix worked.
#
# An allowlist rather than every request, because api_logs is unbounded and a
# row per request across ten apps would bury the third-party rows it exists for.
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
    app_name = next((name for prefix, name in _APP_PREFIX_MAP if path.startswith(prefix)), None)
    if not app_name or not path.endswith(_SELF_TIMED_SUFFIXES):
        return await call_next(request)

    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        _log_self(request, app_name, path, start, 500, None)
        raise
    _log_self(request, app_name, path, start, response.status_code, _content_length(response))
    return response


def _log_self(request, app_name, path, start, status, size) -> None:
    """Write the row, never letting instrumentation break the request."""
    try:
        su_user = getattr(request.state, "supabase_user", None)
        log_self_call(
            app=app_name,
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


# ── Startup ────────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def _startup():
    load_unit_registry()
    load_modifier_registry()


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/api/v1/health", summary="Global health check")
async def health():
    """Returns overall service status."""
    return {"status": "ok", "service": "vibelab"}

# ── Project routers ────────────────────────────────────────────────────────────
# Add a new router here when scaffolding a new project.
app.include_router(sauceboss.router)
app.include_router(wealthmate.router)
app.include_router(spotme.router)
app.include_router(daywordplay.router)
app.include_router(plant_planner.router)
app.include_router(boardgame_buddy.router)
app.include_router(travel_scrapbook.router)
app.include_router(person.router)

# ── Infrastructure routers ────────────────────────────────────────────────
app.include_router(analytics.router)
app.include_router(admin.router)
