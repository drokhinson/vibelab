"""Public SauceBoss API routes — unified items + sauces."""

import logging
import re
import secrets

from fastapi import HTTPException

from db import get_supabase
from shared_models import HealthResponse
from . import router
from .models import (
    CreateSauceRequest,
    IngredientCategoryInput,
    InitialLoadResponse,
    ItemLoadResponse,
)

logger = logging.getLogger("sauceboss")


@router.get("/health", response_model=HealthResponse, summary="SauceBoss health check")
async def health():
    """Health check."""
    return {"project": "sauceboss", "status": "ok"}


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


@router.post("/sauces")
async def create_sauce(body: CreateSauceRequest):
    """Create a user-submitted sauce with steps, ingredients, and item pairings.

    ``sauceType`` selects which dish category this sauce pairs with
    ('sauce'→carb, 'marinade'→protein, 'dressing'→salad). ``itemIds`` lists
    Type-row item ids of that category. The DB trigger on
    sauceboss_sauce_items rejects any sauce_type ↔ item.category mismatch.
    """
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    sauce_id = f"user-{slug}-{secrets.token_hex(2)}"

    payload = {
        "id": sauce_id,
        "name": body.name,
        "cuisine": body.cuisine,
        "cuisineEmoji": body.cuisineEmoji,
        "color": body.color,
        "description": body.description,
        "sauceType": body.sauceType,
        "itemIds": body.itemIds,
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


@router.get("/sauces")
async def list_all_sauces():
    """Public endpoint: all sauces with full steps, ingredients, and compatible carbs."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces_full", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.post("/ingredient-categories")
async def upsert_ingredient_category(body: IngredientCategoryInput):
    """Add or update an ingredient's category classification."""
    sb = get_supabase()
    sb.rpc("upsert_sauceboss_ingredient_category", {
        "p_ingredient_name": body.ingredientName.strip().lower(),
        "p_category": body.category,
    }).execute()
    return {"status": "ok"}


# ── Combined-load endpoints (one round-trip per user action) ─────────────────

def _rpc_or_500(name: str, params: dict, log_label: str):
    """Run a Supabase RPC and surface failure detail in both logs and response."""
    logger.info("[%s] calling RPC %s params=%s", log_label, name, params)
    try:
        result = get_supabase().rpc(name, params).execute()
    except Exception as e:
        logger.exception("[%s] RPC %s raised", log_label, name)
        raise HTTPException(500, f"{log_label} RPC error: {type(e).__name__}: {e}")
    if result.data is None:
        logger.error("[%s] RPC %s returned data=None", log_label, name)
        raise HTTPException(500, f"{log_label} returned no data")
    if isinstance(result.data, (list, dict)):
        size = len(result.data)
        logger.info("[%s] RPC %s ok, payload size=%s top-level keys/items", log_label, name, size)
    else:
        logger.info("[%s] RPC %s ok, type=%s", log_label, name, type(result.data).__name__)
    return result.data


@router.get(
    "/initial-load",
    response_model=InitialLoadResponse,
    summary="Bundle of carbs, proteins, and salad bases for the home screen",
)
async def initial_load() -> InitialLoadResponse:
    """Single round-trip returning all base meal-type lists for the meal builder."""
    return _rpc_or_500("get_sauceboss_initial_load", {}, "initial-load")


@router.get(
    "/items/{item_id}/load",
    response_model=ItemLoadResponse,
    summary="Variants, sauces, and ingredients for any item",
)
async def item_load(item_id: str) -> ItemLoadResponse:
    """Single round-trip returning everything the per-selection screen needs.

    Replaces the legacy carb-load / protein-load / salad-base-load endpoints.
    Returns an empty ``variants`` list for items with no preparation variants
    (proteins and salad bases today). The ``sauces`` field is the universal
    payload regardless of category — the frontend renders it as sauces /
    marinades / dressings based on the calling screen.
    """
    return _rpc_or_500("get_sauceboss_item_load", {"p_item_id": item_id}, f"item-load:{item_id}")
