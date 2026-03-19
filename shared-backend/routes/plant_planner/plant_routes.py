"""Plant catalog routes."""

from db import get_supabase
from . import router


@router.get("/plants")
async def list_plants():
    """List all plants with their render data."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_plants")
        .select("*, plantplanner_renders(*)")
        .order("sort_order")
        .execute()
    )
    # Flatten render data onto the plant object for easy frontend consumption
    plants = []
    for row in result.data:
        render = row.pop("plantplanner_renders", None)
        if render:
            row["render_params"] = render.get("params")
            row["render_colors"] = render.get("colors")
            row["render_label"] = render.get("label")
        plants.append(row)
    return plants
