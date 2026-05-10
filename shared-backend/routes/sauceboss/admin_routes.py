"""Admin SauceBoss API routes — guarded by Supabase JWT + is_admin flag.

POST /admin/ingredients is intentionally relaxed to ``get_current_user`` so any
logged-in user can register an ingredient (the user-add-ingredient flow).
Every other admin route requires ``get_current_admin``.
"""

import hashlib
import re

from fastapi import Depends, HTTPException, Path

from db import get_supabase
from . import router
from .dependencies import CurrentUser, get_current_admin, get_current_user
from .models import (
    AssignVariantsRequest,
    CreateIngredientRequest,
    CreateItemRequest,
    MergeIngredientsRequest,
    MessageResponse,
    UpdateIngredientRequest,
    UpdateItemRequest,
)


def _ingredient_id_for(name: str) -> str:
    """Derive a stable ingredient id from a name, mirroring create_sauceboss_sauce."""
    norm = name.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", norm).strip("-")[:60]
    digest = hashlib.md5(norm.encode("utf-8")).hexdigest()[:6]
    return f"{slug}-{digest}"


@router.get("/admin/sauces", summary="List all sauces with attachments (admin)")
async def admin_list_sauces(_: CurrentUser = Depends(get_current_admin)):
    """Return all sauces with their attachments."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/admin/items", status_code=201, summary="Create a dish (admin)")
async def admin_create_item(
    body: CreateItemRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Add a new dish (carb / protein / salad base, optionally a subtype)."""
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    # dish_level is derived from parent_id: a row with no parent is a 'dish';
    # a row with a parent is a 'subtype'. The sauceboss_dish_level_check
    # trigger enforces this two-tier shape (no subtype-of-subtype).
    dish_level = "subtype" if body.parentId else "dish"
    sb = get_supabase()
    try:
        sb.table("sauceboss_dish").insert({
            "id": slug,
            "category": body.category,
            "parent_id": body.parentId,
            "dish_level": dish_level,
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


@router.patch("/admin/items/{item_id}", summary="Update a dish (admin)")
async def admin_update_item(
    item_id: str,
    body: UpdateItemRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Update an existing carb / protein / salad dish."""
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
        sb.table("sauceboss_dish").update(payload).eq("id", item_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": item_id, "status": "updated"}


@router.delete("/admin/items/{item_id}", summary="Delete a dish (admin)")
async def admin_delete_item(
    item_id: str,
    _: CurrentUser = Depends(get_current_admin),
):
    """Delete a dish; subtypes and sauce_to_dish rows cascade via FK."""
    try:
        get_supabase().table("sauceboss_dish").delete().eq("id", item_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": item_id, "status": "deleted"}


@router.delete("/admin/sauces/{sauce_id}", summary="Delete a sauce (admin)")
async def admin_delete_sauce(
    sauce_id: str,
    _: CurrentUser = Depends(get_current_admin),
):
    """Delete a sauce; steps, ingredients, and sauce_to_dish rows cascade via FK."""
    try:
        get_supabase().table("sauceboss_sauce").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": sauce_id, "status": "deleted"}


# ── Ingredient admin ────────────────────────────────────────────────────────

@router.post(
    "/admin/ingredients",
    status_code=201,
    summary="Create an ingredient (any logged-in user)",
)
async def admin_create_ingredient(
    body: CreateIngredientRequest,
    _: CurrentUser = Depends(get_current_user),
):
    """Insert a new ingredient row. Conflicts on the normalized name return 409."""
    name = body.name.strip()
    norm = name.lower()
    sb = get_supabase()
    existing = sb.table("sauceboss_ingredient").select("id,name").eq("name_normalized", norm).execute()
    if existing.data:
        raise HTTPException(409, f"Ingredient already exists: {existing.data[0]['name']} (id={existing.data[0]['id']})")
    ingredient_id = _ingredient_id_for(name)
    payload = {
        "id": ingredient_id,
        "name": name,
        "plural": body.plural,
        "name_normalized": norm,
    }
    if body.category:
        payload["category"] = body.category
    try:
        sb.table("sauceboss_ingredient").insert(payload).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": ingredient_id, "name": name, "status": "created"}


@router.patch("/admin/ingredients/{ingredient_id}", summary="Rename an ingredient (admin)")
async def admin_update_ingredient(
    ingredient_id: str,
    body: UpdateIngredientRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Rename / recategorize an ingredient. If the new name normalizes to another
    existing ingredient the caller should use the merge endpoint instead — this
    route returns 409 in that case rather than silently merging."""
    new_name = body.name.strip()
    new_norm = new_name.lower()
    sb = get_supabase()
    conflict = (
        sb.table("sauceboss_ingredient")
        .select("id,name")
        .eq("name_normalized", new_norm)
        .neq("id", ingredient_id)
        .execute()
    )
    if conflict.data:
        raise HTTPException(
            409,
            f"Another ingredient already uses this name: {conflict.data[0]['name']} "
            f"(id={conflict.data[0]['id']}). Use merge to combine them.",
        )
    payload: dict = {
        "name": new_name,
        "plural": body.plural,
        "name_normalized": new_norm,
    }
    if body.category is not None:
        payload["category"] = body.category
    if body.substitutions is not None:
        payload["substitutions"] = body.substitutions
    try:
        sb.table("sauceboss_ingredient").update(payload).eq("id", ingredient_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": ingredient_id, "name": new_name, "status": "updated"}


@router.delete("/admin/ingredients/{ingredient_id}", summary="Delete an unused ingredient (admin)")
async def admin_delete_ingredient(
    ingredient_id: str,
    _: CurrentUser = Depends(get_current_admin),
):
    """Delete an ingredient only if no recipe step references it. Returns 409 with
    usage count otherwise — caller can merge the ingredient into another first."""
    sb = get_supabase()
    try:
        result = sb.rpc("delete_sauceboss_ingredient_safe", {"p_id": ingredient_id}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    usage = result.data if isinstance(result.data, int) else 0
    if usage and usage > 0:
        raise HTTPException(409, f"Ingredient is still used by {usage} recipe step row(s). Merge it into another ingredient first.")
    return {"id": ingredient_id, "status": "deleted"}


@router.post(
    "/admin/sauces/{parent_id}/variants",
    response_model=MessageResponse,
    status_code=200,
    summary="Bulk-assign sauces as variants of a parent (admin)",
)
async def admin_assign_sauce_variants(
    body: AssignVariantsRequest,
    parent_id: str = Path(..., description="The sauce to use as the variant family root."),
    _: CurrentUser = Depends(get_current_admin),
) -> MessageResponse:
    """Set ``parent_sauce_id = parent_id`` on every sauce in ``body.sauceIds``.

    Refuses (400) if the parent itself is a variant, if any target is the
    parent, or if any target already has variants of its own — those cases
    would create a two-deep chain that the trigger forbids.
    """
    sauce_ids = [sid for sid in body.sauceIds if sid]
    if not sauce_ids:
        raise HTTPException(400, "No sauce IDs provided")
    if parent_id in sauce_ids:
        raise HTTPException(400, "Parent cannot also appear in sauceIds")

    sb = get_supabase()
    parent = (
        sb.table("sauceboss_sauce")
        .select("id, parent_sauce_id")
        .eq("id", parent_id)
        .execute()
    )
    if not parent.data:
        raise HTTPException(404, f"Parent sauce {parent_id} not found")
    if parent.data[0].get("parent_sauce_id"):
        raise HTTPException(400, "Parent is already a variant — pick the original sauce as the family root")

    targets = (
        sb.table("sauceboss_sauce")
        .select("id")
        .in_("id", sauce_ids)
        .execute()
    )
    found_ids = {row["id"] for row in (targets.data or [])}
    missing = [sid for sid in sauce_ids if sid not in found_ids]
    if missing:
        raise HTTPException(400, f"Sauce(s) not found: {', '.join(missing)}")

    has_children = (
        sb.table("sauceboss_sauce")
        .select("id, parent_sauce_id")
        .in_("parent_sauce_id", sauce_ids)
        .execute()
    )
    if has_children.data:
        offenders = sorted({row["parent_sauce_id"] for row in has_children.data})
        raise HTTPException(
            400,
            f"Cannot make {', '.join(offenders)} a variant: they already have variants of their own. Re-parent those first.",
        )

    sb.table("sauceboss_sauce").update({"parent_sauce_id": parent_id}).in_("id", sauce_ids).execute()
    return MessageResponse(message=f"Assigned {len(sauce_ids)} variant(s) to {parent_id}")


@router.post("/admin/ingredients/merge", summary="Merge ingredients (admin)")
async def admin_merge_ingredients(
    body: MergeIngredientsRequest,
    _: CurrentUser = Depends(get_current_admin),
):
    """Repoint every step ingredient on ``mergeIds`` to ``keepId`` and delete
    the merged ingredient rows. Atomic at the DB level."""
    if body.keepId in body.mergeIds:
        raise HTTPException(400, "keepId cannot also appear in mergeIds")
    sb = get_supabase()
    try:
        result = sb.rpc("merge_sauceboss_ingredients", {
            "p_keep": body.keepId,
            "p_merge": body.mergeIds,
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
