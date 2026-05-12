"""
main.py — vibelab shared FastAPI backend
ONE service handles ALL projects. Each project registers its own router.
Routes are namespaced: /api/v1/{project}/...
"""
import os
import truststore
truststore.inject_into_ssl()  # use OS certificate store instead of certifi bundle

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from api_logger import set_request_user
from jwt_auth import get_current_supabase_user
from routes.sauceboss.units import load_unit_registry

# Project routers
from routes import sauceboss
from routes import wealthmate
from routes import spotme
from routes import daywordplay
from routes import plant_planner
from routes import boardgame_buddy

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


# ── api_logger user-context middleware ────────────────────────────────────────
# Attach the authenticated user to api_logger contextvars for EVERY request,
# regardless of whether the route declares Depends(get_current_user). Without
# this, anonymous-friendly routes (plant-planner catalog/cache-fill, BGG public
# catalog) emit api_logs rows with NULL user_id even when the caller's JWT
# identifies a real user.
_APP_PREFIX_MAP = [
    ("/api/v1/plant-planner/",   "plant-planner"),
    ("/api/v1/boardgame-buddy/", "boardgame-buddy"),
    ("/api/v1/sauceboss/",       "sauceboss"),
    ("/api/v1/wealthmate/",      "wealthmate"),
    ("/api/v1/daywordplay/",     "daywordplay"),
    ("/api/v1/spotme/",          "spotme"),
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
                su_user = await get_current_supabase_user(authorization=authz)
                await set_request_user(
                    user_id=su_user.sub,
                    user_label=su_user.email or su_user.sub,
                    app=app_name,
                )
            except Exception:
                # Invalid / expired token, JWKS hiccup, etc — log row will fall
                # back to anonymous. Never let this fail the request.
                pass
    return await call_next(request)


# ── Startup ────────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def _startup():
    load_unit_registry()


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

# ── Infrastructure routers ────────────────────────────────────────────────
app.include_router(analytics.router)
app.include_router(admin.router)
