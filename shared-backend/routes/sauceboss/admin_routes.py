"""Admin SauceBoss API routes — requires admin API key."""

import re
from typing import Optional

from fastapi import HTTPException, Header

from auth import require_admin
from db import get_supabase
from . import router
from .models import CreateItemRequest


@router.get("/admin/sauces")
async def admin_list_sauces(authorization: Optional[str] = Header(None)):
    """Return all sauces with their compatible carbs. Requires admin key."""
    require_admin(authorization)
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/admin/items")
async def admin_create_item(body: CreateItemRequest, authorization: Optional[str] = Header(None)):
    """Add a new item (carb / protein / salad base, optionally a variant). Requires admin key."""
    require_admin(authorization)
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    sb = get_supabase()
    try:
        sb.table("sauceboss_items").insert({
            "id": slug,
            "category": body.category,
            "parent_id": body.parentId,
            "name": body.name,
            "emoji": body.emoji,
            "description": body.description,
            "sort_order": body.sortOrder,
            "cook_time_minutes": body.cookTimeMinutes,
            "instructions": body.instructions,
            "water_ratio": body.waterRatio,
            "portion_per_person": body.portionPerPerson,
            "portion_unit": body.portionUnit,
        }).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": slug, "status": "created"}


@router.delete("/admin/sauces/{sauce_id}")
async def admin_delete_sauce(sauce_id: str, authorization: Optional[str] = Header(None)):
    """Delete a sauce and all its steps/ingredients. Requires admin key."""
    require_admin(authorization)
    sb = get_supabase()
    try:
        steps = sb.table("sauceboss_sauce_steps").select("id").eq("sauce_id", sauce_id).execute()
        step_ids = [s["id"] for s in (steps.data or [])]
        if step_ids:
            sb.table("sauceboss_step_ingredients").delete().in_("step_id", step_ids).execute()
        sb.table("sauceboss_sauce_steps").delete().eq("sauce_id", sauce_id).execute()
        sb.table("sauceboss_sauce_items").delete().eq("sauce_id", sauce_id).execute()
        sb.table("sauceboss_sauces").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": sauce_id, "status": "deleted"}
