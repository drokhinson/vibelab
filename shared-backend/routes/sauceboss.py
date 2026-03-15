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
import re
import secrets
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from db import get_supabase


# ── Pydantic models for sauce creation ───────────────────────────────────────
class IngredientInput(BaseModel):
    name: str = Field(min_length=1)
    amount: float = Field(gt=0)
    unit: str = Field(min_length=1)

class StepInput(BaseModel):
    title: str = Field(min_length=1)
    ingredients: List[IngredientInput] = Field(min_length=1)

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
                "ingredients": [
                    {"name": ing.name, "amount": ing.amount, "unit": ing.unit}
                    for ing in step.ingredients
                ],
            }
            for idx, step in enumerate(body.steps)
        ],
    }

    sb = get_supabase()
    result = sb.rpc("create_sauceboss_sauce", {"p_data": payload}).execute()
    if result.data is None:
        raise HTTPException(500, "Failed to create sauce")
    return {"id": result.data, "status": "created"}
