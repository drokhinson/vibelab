"""
main.py — vibelab shared FastAPI backend
ONE service handles ALL projects. Each project registers its own router.
Routes are namespaced: /api/v1/{project}/...
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

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
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

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
