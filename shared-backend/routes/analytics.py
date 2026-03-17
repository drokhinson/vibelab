"""
routes/analytics.py — Cross-app analytics tracking
POST /api/v1/analytics/track — fire-and-forget event logging (no auth)
GET  /api/v1/analytics/summary — admin-only aggregate counts
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

from db import get_supabase
from auth import require_admin

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TrackBody(BaseModel):
    app: str
    event: str = "app_open"
    metadata: Optional[dict] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {"project": "analytics", "status": "ok"}


@router.post("/track")
async def track_event(body: TrackBody):
    """Record an analytics event. No auth — called by app frontends on load."""
    sb = get_supabase()
    row = {"app": body.app, "event": body.event}
    if body.metadata:
        row["metadata"] = body.metadata
    sb.table("analytics_events").insert(row).execute()
    return {"ok": True}


@router.get("/summary")
async def analytics_summary(authorization: Optional[str] = Header(None)):
    """Per-app event counts for 24h, 7d, 30d, and all-time. Admin-only."""
    require_admin(authorization)

    sb = get_supabase()
    now = datetime.now(timezone.utc)
    cutoffs = {
        "last_24h": now - timedelta(hours=24),
        "last_7d": now - timedelta(days=7),
        "last_30d": now - timedelta(days=30),
    }

    # Fetch all events (filtered server-side by Supabase)
    all_result = sb.table("analytics_events").select("app, created_at").execute()
    rows = all_result.data or []

    # Build per-app counts
    apps = {}
    for row in rows:
        app = row["app"]
        if app not in apps:
            apps[app] = {"all_time": 0, "last_24h": 0, "last_7d": 0, "last_30d": 0}
        apps[app]["all_time"] += 1
        created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        for period, cutoff in cutoffs.items():
            if created >= cutoff:
                apps[app][period] += 1

    return {"apps": apps}


