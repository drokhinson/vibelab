"""Companion-planting catalog routes."""

from typing import List

from db import get_supabase
from . import router
from .models import CompanionResponse


@router.get(
    "/companions",
    response_model=List[CompanionResponse],
    summary="List companion-planting relationships",
)
async def list_companions() -> List[CompanionResponse]:
    """List all companion-planting relationship rows. Stored as ordered (a<b) pairs; clients expand bidirectionally."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_companions")
        .select("plant_a_id, plant_b_id, relationship, reason")
        .execute()
    )
    return [CompanionResponse(**row) for row in (result.data or [])]
