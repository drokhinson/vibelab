"""Meta + color-scheme routes: health, admin key check, color-scheme presets."""

from typing import List, Optional

from fastapi import Header

from auth import require_admin
from db import get_supabase
from shared_models import HealthResponse, StatusResponse

from . import router
from .models import ColorSchemeResponse


@router.get("/health", response_model=HealthResponse, status_code=200, summary="Health check")
async def health() -> HealthResponse:
    """Service health for TripGuide. No auth."""
    return HealthResponse(project="trip-guide", status="ok")


@router.get("/admin/health", response_model=StatusResponse, status_code=200, summary="Validate admin key")
async def admin_health(authorization: Optional[str] = Header(None)) -> StatusResponse:
    """Probe endpoint the web app hits to validate the entered admin code."""
    require_admin(authorization)
    return StatusResponse(status="ok")


@router.get(
    "/color-schemes",
    response_model=List[ColorSchemeResponse],
    status_code=200,
    summary="List color-scheme presets",
)
async def list_color_schemes() -> List[ColorSchemeResponse]:
    """Return all color-scheme presets ordered for display. No auth."""
    sb = get_supabase()
    result = (
        sb.table("tripguide_color_schemes")
        .select("*")
        .order("sort_order")
        .execute()
    )
    return [ColorSchemeResponse(**row) for row in (result.data or [])]
