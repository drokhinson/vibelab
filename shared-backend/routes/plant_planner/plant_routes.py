"""Plant catalog routes."""

from typing import List, Optional

from db import get_supabase
from . import router
from .models import PlantResponse


def _parse_int4range(value: Optional[str]) -> Optional[dict]:
    """Convert a Postgres int4range string to {"min": int, "max": int}.

    Postgres normalizes discrete ranges to half-open `[lower, upper)` form on
    read, but inputs like `(a,b]` or `[a,b]` may also appear. Returns None for
    null, empty, or the literal `empty` range.
    """
    if value is None:
        return None
    text = value.strip()
    if not text or text.lower() == "empty":
        return None

    lower_bracket = text[0]
    upper_bracket = text[-1]
    inner = text[1:-1]
    if "," not in inner:
        return None
    lower_str, upper_str = inner.split(",", 1)
    lower_str = lower_str.strip()
    upper_str = upper_str.strip()
    if not lower_str or not upper_str:
        return None

    lower = int(lower_str)
    upper = int(upper_str)
    if lower_bracket == "(":
        lower += 1
    if upper_bracket == ")":
        upper -= 1
    return {"min": lower, "max": upper}


@router.get("/plants", response_model=List[PlantResponse], summary="List plant catalog")
async def list_plants() -> List[PlantResponse]:
    """List all plants with their render data and enrichment fields."""
    sb = get_supabase()
    result = (
        sb.table("plantplanner_plants")
        .select("*, plantplanner_renders(*)")
        .order("sort_order")
        .execute()
    )
    plants: List[PlantResponse] = []
    for row in result.data:
        render = row.pop("plantplanner_renders", None)
        if render:
            row["render_params"] = render.get("params")
            row["render_colors"] = render.get("colors")
            row["render_label"] = render.get("label")
        row["usda_zones"] = _parse_int4range(row.get("usda_zones"))
        plants.append(PlantResponse(**row))
    return plants
