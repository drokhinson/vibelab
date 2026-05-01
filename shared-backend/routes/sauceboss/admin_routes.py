"""Admin SauceBoss API routes — guarded by Supabase JWT + is_admin flag.

POST /admin/foods is intentionally relaxed to ``get_current_user`` so any
logged-in user can register an ingredient (the user-add-ingredient flow).
Every other admin route requires ``get_current_admin``.
"""

import hashlib
import re

from fastapi import Depends, HTTPException

from db import get_supabase
from . import router
from .dependencies import CurrentUser, get_current_admin, get_current_user
from .models import (
    CreateFoodRequest,
    CreateItemRequest,
    MergeFoodsRequest,
    UpdateFoodRequest,
    UpdateItemRequest,
)


def _food_id_for(name: str) -> str:
    """Derive a stable food id from a name, mirroring create_sauceboss_sauce."""
    norm = name.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", norm).strip("-")[:60]
    digest = hashlib.md5(norm.encode("utf-8")).hexdigest()[:6]
    return f"{slug}-{digest}"


@router.get("/admin/sauces", summary="List all sauces with compatible items (admin)")
async def admin_list_sauces(_: CurrentUser = Depends(get_current_admin)):
    """Return all sauces with their compatible items."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/admin/items", status_code=201, summary="Create an item (admin)")
async def admin_create_item(
    body: CreateItemRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Add a new item (carb / protein / salad base, optionally a variant)."""
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


@router.patch("/admin/items/{item_id}", summary="Update an item (admin)")
async def admin_update_item(
    item_id: str,
    body: UpdateItemRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Update an existing carb / protein / salad item."""
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


@router.delete("/admin/items/{item_id}", summary="Delete an item (admin)")
async def admin_delete_item(
    item_id: str,
    _: CurrentUser = Depends(get_current_admin),
):
    """Delete an item; child variants and sauce_items rows cascade via FK."""
    try:
        get_supabase().table("sauceboss_items").delete().eq("id", item_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": item_id, "status": "deleted"}


@router.delete("/admin/sauces/{sauce_id}", summary="Delete a sauce (admin)")
async def admin_delete_sauce(
    sauce_id: str,
    _: CurrentUser = Depends(get_current_admin),
):
    """Delete a sauce; steps, ingredients, and sauce_items rows cascade via FK."""
    try:
        get_supabase().table("sauceboss_sauces").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": sauce_id, "status": "deleted"}


# ── Foods (ingredient admin) ────────────────────────────────────────────────

@router.post(
    "/admin/foods",
    status_code=201,
    summary="Create an ingredient (any logged-in user)",
)
async def admin_create_food(
    body: CreateFoodRequest,
    _: CurrentUser = Depends(get_current_user),
):
    """Insert a new food row. Conflicts on the normalized name return 409."""
    name = body.name.strip()
    norm = name.lower()
    sb = get_supabase()
    existing = sb.table("sauceboss_foods").select("id,name").eq("name_normalized", norm).execute()
    if existing.data:
        raise HTTPException(409, f"Ingredient already exists: {existing.data[0]['name']} (id={existing.data[0]['id']})")
    food_id = _food_id_for(name)
    try:
        sb.table("sauceboss_foods").insert({
            "id": food_id,
            "name": name,
            "plural": body.plural,
            "name_normalized": norm,
        }).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": food_id, "name": name, "status": "created"}


@router.patch("/admin/foods/{food_id}", summary="Rename an ingredient (admin)")
async def admin_update_food(
    food_id: str,
    body: UpdateFoodRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Rename a food. If the new name normalizes to another existing food, the
    caller should use the merge endpoint instead — this route returns 409 in
    that case rather than silently merging."""
    new_name = body.name.strip()
    new_norm = new_name.lower()
    sb = get_supabase()
    conflict = (
        sb.table("sauceboss_foods")
        .select("id,name")
        .eq("name_normalized", new_norm)
        .neq("id", food_id)
        .execute()
    )
    if conflict.data:
        raise HTTPException(
            409,
            f"Another ingredient already uses this name: {conflict.data[0]['name']} "
            f"(id={conflict.data[0]['id']}). Use merge to combine them.",
        )
    try:
        sb.table("sauceboss_foods").update({
            "name": new_name,
            "plural": body.plural,
            "name_normalized": new_norm,
        }).eq("id", food_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": food_id, "name": new_name, "status": "updated"}


@router.delete("/admin/foods/{food_id}", summary="Delete an unused ingredient (admin)")
async def admin_delete_food(
    food_id: str,
    _: CurrentUser = Depends(get_current_admin),
):
    """Delete a food only if no recipe step references it. Returns 409 with
    usage count otherwise — caller can merge the food into another first."""
    sb = get_supabase()
    try:
        result = sb.rpc("delete_sauceboss_food_safe", {"p_id": food_id}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    usage = result.data if isinstance(result.data, int) else 0
    if usage and usage > 0:
        raise HTTPException(409, f"Ingredient is still used by {usage} recipe step row(s). Merge it into another ingredient first.")
    return {"id": food_id, "status": "deleted"}


@router.post("/admin/foods/merge", summary="Merge ingredients (admin)")
async def admin_merge_foods(
    body: MergeFoodsRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Repoint every step ingredient on ``mergeIds`` to ``keepId`` and delete
    the merged food rows. Atomic at the DB level."""
    if body.keepId in body.mergeIds:
        raise HTTPException(400, "keepId cannot also appear in mergeIds")
    sb = get_supabase()
    try:
        result = sb.rpc("merge_sauceboss_foods", {
            "p_keep_id": body.keepId,
            "p_merge_ids": body.mergeIds,
        }).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    repointed = result.data if isinstance(result.data, int) else 0
    return {
        "keepId": body.keepId,
        "mergedIds": body.mergeIds,
        "repointedRows": repointed,
        "status": "merged",
    }
