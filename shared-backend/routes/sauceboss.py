"""
routes/sauceboss.py — SauceBoss API routes
All routes at /api/v1/sauceboss/...

Supabase tables (all prefixed sauceboss_):
  sauceboss_carbs            — id (text PK), name, emoji, description
  sauceboss_sauces           — id, name, cuisine, cuisine_emoji, color, description
  sauceboss_sauce_carbs      — sauce_id, carb_id (junction)
  sauceboss_sauce_steps      — id (bigserial), sauce_id, step_order, title
  sauceboss_step_ingredients — id (bigserial), step_id, name, amount, unit

Complex reads use the Supabase RPC get_sauceboss_sauces_for_carb(p_carb_id text).
"""
import os
import re
import secrets
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

from db import get_supabase

ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "dev-admin-key")


def _require_admin(authorization: Optional[str] = None):
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization required")
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or parts[1] != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")


# ── Pydantic models for sauce creation ───────────────────────────────────────
class IngredientInput(BaseModel):
    name: str = Field(min_length=1)
    amount: float = Field(gt=0)
    unit: str = Field(min_length=1)

class StepInput(BaseModel):
    title: str = Field(min_length=1)
    ingredients: List[IngredientInput] = Field(min_length=1)
    inputFromStep: int | None = None

class CreateSauceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    cuisine: str = Field(min_length=1)
    cuisineEmoji: str = ""
    color: str = Field(pattern=r'^#[0-9A-Fa-f]{6}$')
    description: str = ""
    carbIds: List[str] = Field(min_length=1)
    steps: List[StepInput] = Field(min_length=1)

router = APIRouter(prefix="/api/v1/sauceboss", tags=["sauceboss"])


@router.get("/health")
async def health():
    return {"project": "sauceboss", "status": "ok"}


@router.get("/carbs")
async def list_carbs():
    """
    Returns all carbs. Each carb includes a sauceCount derived from sauce_carbs.
    Shape: [{ id, name, emoji, description, sauceCount }]
    """
    sb = get_supabase()
    # Fetch carbs + count sauces via RPC to keep it one round-trip
    result = sb.rpc("get_sauceboss_carbs_with_count", {}).execute()
    if result.data is None:
        raise HTTPException(500, "Failed to load carbs")
    return result.data


@router.get("/carbs/{carb_id}/sauces")
async def sauces_for_carb(carb_id: str):
    """
    Returns fully assembled sauce objects for a given carb.
    Shape matches the original SAUCES data:
      { id, name, cuisine, cuisineEmoji, color, description,
        compatibleCarbs[], ingredients[], steps[{ title, ingredients[] }] }
    """
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_sauces_for_carb", {"p_carb_id": carb_id}).execute()
    if result.data is None:
        raise HTTPException(404, f"No sauces found for carb '{carb_id}'")
    return result.data


@router.get("/carbs/{carb_id}/ingredients")
async def ingredients_for_carb(carb_id: str):
    """
    Returns sorted list of unique ingredient names for all sauces compatible
    with carb_id. Used to populate the ingredient filter panel.
    Shape: ["garlic", "ginger", ...]
    """
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_ingredients_for_carb", {"p_carb_id": carb_id}).execute()
    if result.data is None:
        return []
    return result.data


@router.get("/ingredient-categories")
async def list_ingredient_categories():
    """Returns ingredient → category mappings for grouping in the filter panel."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_ingredient_categories", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.get("/substitutions")
async def list_substitutions():
    """Returns ingredient substitution suggestions."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_substitutions", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.get("/carbs/{carb_id}/preparations")
async def preparations_for_carb(carb_id: str):
    """Returns preparation options for a given carb (e.g., spaghetti/penne for pasta)."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_carb_preparations", {"p_carb_id": carb_id}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/sauces")
async def create_sauce(body: CreateSauceRequest):
    """Create a user-submitted sauce with steps, ingredients, and carb pairings."""
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    sauce_id = f"user-{slug}-{secrets.token_hex(2)}"

    payload = {
        "id": sauce_id,
        "name": body.name,
        "cuisine": body.cuisine,
        "cuisineEmoji": body.cuisineEmoji,
        "color": body.color,
        "description": body.description,
        "carbIds": body.carbIds,
        "steps": [
            {
                "title": step.title,
                "stepOrder": idx + 1,
                "inputFromStep": step.inputFromStep,
                "ingredients": [
                    {"name": ing.name, "amount": ing.amount, "unit": ing.unit}
                    for ing in step.ingredients
                ],
            }
            for idx, step in enumerate(body.steps)
        ],
    }

    sb = get_supabase()
    try:
        result = sb.rpc("create_sauceboss_sauce", {"p_data": payload}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    if result.data is None:
        raise HTTPException(500, "Failed to create sauce — RPC returned null")
    return {"id": result.data, "status": "created"}


class IngredientCategoryInput(BaseModel):
    ingredientName: str = Field(min_length=1)
    category: str = Field(min_length=1)


@router.get("/addons")
async def list_addons():
    """Returns protein and veggie addon options with instructions and timing."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_addons", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/ingredient-categories")
async def upsert_ingredient_category(body: IngredientCategoryInput):
    """Add or update an ingredient's category classification."""
    sb = get_supabase()
    result = sb.rpc("upsert_sauceboss_ingredient_category", {
        "p_ingredient_name": body.ingredientName.strip().lower(),
        "p_category": body.category,
    }).execute()
    return {"status": "ok"}


# ── Admin endpoints ───────────────────────────────────────────────────────────

@router.get("/admin/sauces")
async def admin_list_sauces(authorization: Optional[str] = Header(None)):
    """Return all sauces with their compatible carbs. Requires admin key."""
    _require_admin(authorization)
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.delete("/admin/sauces/{sauce_id}")
async def admin_delete_sauce(sauce_id: str, authorization: Optional[str] = Header(None)):
    """Delete a sauce and all its steps/ingredients. Requires admin key."""
    _require_admin(authorization)
    sb = get_supabase()
    try:
        # Get step IDs first for cascading delete
        steps = sb.table("sauceboss_sauce_steps").select("id").eq("sauce_id", sauce_id).execute()
        step_ids = [s["id"] for s in (steps.data or [])]
        if step_ids:
            sb.table("sauceboss_step_ingredients").delete().in_("step_id", step_ids).execute()
        sb.table("sauceboss_sauce_steps").delete().eq("sauce_id", sauce_id).execute()
        sb.table("sauceboss_sauce_carbs").delete().eq("sauce_id", sauce_id).execute()
        result = sb.table("sauceboss_sauces").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return {"id": sauce_id, "status": "deleted"}
