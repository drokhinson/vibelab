"""Public SauceBoss API routes — carbs, sauces, dressings, marinades."""

import re
import secrets

from fastapi import HTTPException

from db import get_supabase
from shared_models import HealthResponse
from . import router
from .models import CreateSauceRequest, IngredientCategoryInput


@router.get("/health", response_model=HealthResponse, summary="SauceBoss health check")
async def health():
    """Health check."""
    return {"project": "sauceboss", "status": "ok"}


@router.get("/carbs")
async def list_carbs():
    """Returns all carbs with sauce counts."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_carbs_with_count", {}).execute()
    if result.data is None:
        raise HTTPException(500, "Failed to load carbs")
    return result.data


@router.get("/carbs/{carb_id}/sauces")
async def sauces_for_carb(carb_id: str):
    """Returns fully assembled sauce objects for a given carb."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_sauces_for_carb", {"p_carb_id": carb_id}).execute()
    if result.data is None:
        raise HTTPException(404, f"No sauces found for carb '{carb_id}'")
    return result.data


@router.get("/carbs/{carb_id}/ingredients")
async def ingredients_for_carb(carb_id: str):
    """Returns sorted unique ingredient names for all sauces compatible with a carb."""
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
    """Returns preparation options for a given carb."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_carb_preparations", {"p_carb_id": carb_id}).execute()
    if result.data is None:
        return []
    return result.data


@router.get("/units", summary="List all supported units")
async def list_units():
    """Returns all unit definitions with type classification and metric conversion factors."""
    sb = get_supabase()
    result = sb.table("sauceboss_units").select("*").order("abbreviation").execute()
    return result.data or []


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
        "sauce_type": body.sauce_type,
        "servings": body.servings,
        "yield_quantity": body.yield_quantity,
        "yield_unit": body.yield_unit,
        "source_url": body.source_url,
        "source_name": body.source_name,
        "carbIds": body.carbIds,
        "steps": [
            {
                "title": step.title,
                "stepOrder": idx + 1,
                "inputFromStep": step.inputFromStep,
                "ingredients": [
                    {
                        "name": ing.name,
                        "amount": ing.amount,
                        "unit": ing.unit,
                        "unit_type": ing.unit_type,
                        "original_text": ing.original_text,
                    }
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


@router.get("/addons")
async def list_addons():
    """Returns protein and veggie addon options with instructions and timing."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_addons", {}).execute()
    if result.data is None:
        return []
    return result.data


# ── Dressings path ────────────────────────────────────────────────────────────

@router.get("/salad-bases")
async def list_salad_bases():
    """Returns all salad bases with count of paired dressings."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_salad_bases_with_count", {}).execute()
    if result.data is None:
        raise HTTPException(500, "Failed to load salad bases")
    return result.data


@router.get("/salad-bases/{base_id}/dressings")
async def dressings_for_base(base_id: str):
    """Returns fully assembled dressings for a given salad base."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_dressings_for_base", {"p_base_id": base_id}).execute()
    if result.data is None:
        raise HTTPException(404, f"No dressings found for base '{base_id}'")
    return result.data


@router.get("/salad-bases/{base_id}/ingredients")
async def ingredients_for_base(base_id: str):
    """Returns sorted unique ingredient names across all dressings for a salad base."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_ingredients_for_base", {"p_base_id": base_id}).execute()
    if result.data is None:
        return []
    return result.data


# ── Marinades path ────────────────────────────────────────────────────────────

@router.get("/proteins")
async def list_proteins():
    """Returns protein addons with marinade count for the marinades tab."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_proteins", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.get("/proteins/{addon_id}/marinades")
async def marinades_for_protein(addon_id: str):
    """Returns fully assembled marinades for a given protein addon."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_marinades_for_protein", {"p_addon_id": addon_id}).execute()
    if result.data is None:
        raise HTTPException(404, f"No marinades found for protein '{addon_id}'")
    return result.data


@router.get("/proteins/{addon_id}/ingredients")
async def ingredients_for_protein(addon_id: str):
    """Returns sorted unique ingredient names across all marinades for a protein."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_ingredients_for_protein", {"p_addon_id": addon_id}).execute()
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
