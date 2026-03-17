"""Plant catalog routes."""

from db import get_supabase
from . import router


@router.get("/plants")
async def list_plants():
    sb = get_supabase()
    result = (
        sb.table("plantplanner_plants")
        .select("*")
        .order("sort_order")
        .execute()
    )
    return result.data
