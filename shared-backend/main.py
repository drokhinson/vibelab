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

# Infrastructure routers
from routes import analytics
from routes import admin

load_dotenv()

app = FastAPI(title="vibelab API", version="1.0.0", docs_url="/docs")

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
@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "service": "vibelab"}

# ── Project routers ────────────────────────────────────────────────────────────
# Add a new router here when scaffolding a new project.
app.include_router(sauceboss.router)
app.include_router(wealthmate.router)
app.include_router(spotme.router)
app.include_router(daywordplay.router)

# ── Infrastructure routers ────────────────────────────────────────────────
app.include_router(analytics.router)
app.include_router(admin.router)
