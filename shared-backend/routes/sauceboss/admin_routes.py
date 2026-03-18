"""Admin SauceBoss API routes — requires admin API key."""

import re
from typing import Optional

from fastapi import HTTPException, Header

from auth import require_admin
from db import get_supabase
from . import router
from .models import CreateCarbRequest, CreateAddonRequest


@router.get("/admin/sauces")
async def admin_list_sauces(authorization: Optional[str] = Header(None)):
    """Return all sauces with their compatible carbs. Requires admin key."""
    require_admin(authorization)
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/admin/carbs")
async def admin_create_carb(body: CreateCarbRequest, authorization: Optional[str] = Header(None)):
    """Add a new carb type. Requires admin key."""
    require_admin(authorization)
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    sb = get_supabase()
    try:
        sb.table("sauceboss_carbs").insert({
            "id": slug,
            "name": body.name,
            "emoji": body.emoji,
            "description": body.description,
            "cook_time_minutes": body.cookTimeMinutes,
            "cook_time_label": body.cookTimeLabel,
        }).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": slug, "status": "created"}


@router.post("/admin/addons")
async def admin_create_addon(body: CreateAddonRequest, authorization: Optional[str] = Header(None)):
    """Add a new protein or veggie addon. Requires admin key."""
    require_admin(authorization)
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    sb = get_supabase()
    try:
        sb.table("sauceboss_addons").insert({
            "id": slug,
            "type": body.type,
            "name": body.name,
            "emoji": body.emoji,
            "description": body.desc,
            "instructions": body.instructions,
            "estimated_time": body.estimatedTime,
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
        sb.table("sauceboss_sauce_carbs").delete().eq("sauce_id", sauce_id).execute()
        sb.table("sauceboss_sauces").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": sauce_id, "status": "deleted"}
