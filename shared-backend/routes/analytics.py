"""
routes/analytics.py — Cross-app analytics tracking
POST /api/v1/analytics/track — fire-and-forget event logging (no auth)
GET  /api/v1/analytics/summary — admin-only aggregate counts
"""

from typing import Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel

from db import get_supabase
from auth import require_admin
from shared_models import HealthResponse

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class TrackBody(BaseModel):
    app: str
    event: str = "app_open"
    metadata: Optional[dict] = None


class TrackResponse(BaseModel):
    ok: bool


class AppCounts(BaseModel):
    all_time: int
    last_24h: int
    last_7d: int
    last_30d: int


class SummaryResponse(BaseModel):
    apps: dict[str, AppCounts]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/health", response_model=HealthResponse, summary="Analytics health check")
async def health() -> HealthResponse:
    """Health check."""
    return HealthResponse(project="analytics", status="ok")


@router.post("/track", response_model=TrackResponse, status_code=200, summary="Record an analytics event")
async def track_event(body: TrackBody) -> TrackResponse:
    """Record an analytics event. No auth — called by app frontends on load."""
    sb = get_supabase()
    row = {"app": body.app, "event": body.event}
    if body.metadata:
        row["metadata"] = body.metadata
    sb.table("analytics_events").insert(row).execute()
    return TrackResponse(ok=True)


@router.get("/summary", response_model=SummaryResponse, status_code=200, summary="Per-app event counts (admin)")
async def analytics_summary(
    authorization: Optional[str] = Header(None),
) -> SummaryResponse:
    """Per-app event counts for 24h, 7d, 30d, and all-time. Admin-only.

    Aggregates in SQL via the ``analytics_summary_counts`` RPC. The old
    fetch-all-rows-then-count path silently truncated at PostgREST's
    ``max-rows`` (1000), making low-volume / recently-added apps appear
    empty in the admin dashboard.
    """
    require_admin(authorization)
    sb = get_supabase()
    result = sb.rpc("analytics_summary_counts").execute()
    apps = {
        row["app"]: AppCounts(
            all_time=row["all_time"],
            last_24h=row["last_24h"],
            last_7d=row["last_7d"],
            last_30d=row["last_30d"],
        )
        for row in (result.data or [])
    }
    return SummaryResponse(apps=apps)


