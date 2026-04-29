"""Admin SauceBoss API routes — requires admin API key."""

import re
from typing import Optional

from fastapi import HTTPException, Header

from auth import require_admin
from db import get_supabase
from . import router
from .models import CreateItemRequest, UpdateItemRequest


@router.get("/admin/sauces")
async def admin_list_sauces(authorization: Optional[str] = Header(None)):
    """Return all sauces with their compatible carbs. Requires admin key."""
    require_admin(authorization)
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.get("/admin/items")
async def admin_list_items(authorization: Optional[str] = Header(None)):
    """Return all items grouped by category with variants nested under each parent. Requires admin key."""
    require_admin(authorization)
    sb = get_supabase()
    result = sb.table("sauceboss_items").select(
        "id,category,parent_id,name,emoji,description,sort_order,"
        "cook_time_minutes,instructions,water_ratio,portion_per_person,portion_unit"
    ).order("sort_order").order("name").execute()
    rows = result.data or []

    def shape(r: dict) -> dict:
        return {
            "id": r["id"],
            "category": r["category"],
            "parentId": r.get("parent_id"),
            "name": r["name"],
            "emoji": r.get("emoji") or "",
            "description": r.get("description") or "",
            "sortOrder": r.get("sort_order") or 0,
            "cookTimeMinutes": r.get("cook_time_minutes"),
            "instructions": r.get("instructions"),
            "waterRatio": r.get("water_ratio"),
            "portionPerPerson": r.get("portion_per_person"),
            "portionUnit": r.get("portion_unit"),
        }

    parents_by_id: dict[str, dict] = {}
    orphan_variants: list[dict] = []
    for r in rows:
        if r.get("parent_id") is None:
            it = shape(r)
            it["variants"] = []
            parents_by_id[r["id"]] = it

    for r in rows:
        if r.get("parent_id") is None:
            continue
        parent = parents_by_id.get(r["parent_id"])
        if parent is None:
            orphan_variants.append(shape(r))
        else:
            parent["variants"].append(shape(r))

    grouped: dict[str, list[dict]] = {"carbs": [], "proteins": [], "salads": []}
    for parent in parents_by_id.values():
        if parent["category"] == "carb":
            grouped["carbs"].append(parent)
        elif parent["category"] == "protein":
            grouped["proteins"].append(parent)
        elif parent["category"] == "salad":
            grouped["salads"].append(parent)

    if orphan_variants:
        grouped["orphans"] = orphan_variants
    return grouped


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


@router.patch("/admin/items/{item_id}")
async def admin_update_item(
    item_id: str,
    body: UpdateItemRequest,
    authorization: Optional[str] = Header(None),
):
    """Update an existing carb / protein / salad item. Requires admin key."""
    require_admin(authorization)
    payload = {k: v for k, v in {
        "name": body.name,
        "emoji": body.emoji,
        "description": body.description,
        "sort_order": body.sortOrder,
        "cook_time_minutes": body.cookTimeMinutes,
        "instructions": body.instructions,
        "water_ratio": body.waterRatio,
        "portion_per_person": body.portionPerPerson,
        "portion_unit": body.portionUnit,
    }.items() if v is not None}
    if not payload:
        raise HTTPException(400, "No fields provided to update")
    sb = get_supabase()
    try:
        sb.table("sauceboss_items").update(payload).eq("id", item_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": item_id, "status": "updated"}


@router.delete("/admin/items/{item_id}")
async def admin_delete_item(item_id: str, authorization: Optional[str] = Header(None)):
    """Delete an item; child variants and sauce_items rows cascade via FK."""
    require_admin(authorization)
    try:
        get_supabase().table("sauceboss_items").delete().eq("id", item_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": item_id, "status": "deleted"}


@router.delete("/admin/sauces/{sauce_id}")
async def admin_delete_sauce(sauce_id: str, authorization: Optional[str] = Header(None)):
    """Delete a sauce; steps, ingredients, and sauce_items rows cascade via FK."""
    require_admin(authorization)
    try:
        get_supabase().table("sauceboss_sauces").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": sauce_id, "status": "deleted"}
