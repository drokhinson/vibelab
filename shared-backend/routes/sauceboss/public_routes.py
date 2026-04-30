"""Public SauceBoss API routes — unified items + sauces."""

import logging
import re
import secrets

from fastapi import HTTPException, Query

from db import get_supabase
from shared_models import HealthResponse
from . import router
from .models import (
    CreateSauceRequest,
    FoodRow,
    FoodsListResponse,
    FoodsWithUsageResponse,
    ImportRecipeRequest,
    IngredientCategoryInput,
    InitialLoadResponse,
    ItemLoadResponse,
    ItemsGroupedResponse,
    ParsedIngredientResponse,
    ParsedRecipeResponse,
    UnitRow,
    UnitsListResponse,
    _shape_items_grouped,
)
from .parser import ScrapeError, ScrapeErrorKind, scrape_recipe
from .units import UNIT_REGISTRY, parse_unit, to_canonical

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

    Each ingredient's raw ``unit`` string is resolved against the unit registry
    here and emitted to the RPC as ``unitId`` + canonical quantities; foods are
    upserted by the RPC keyed on lower(name).
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
        "sourceUrl": body.sourceUrl,
        "sauceType": body.sauceType,
        "itemIds": body.itemIds,
        "steps": [
            {
                "title": step.title,
                "stepOrder": idx + 1,
                "inputFromStep": step.inputFromStep,
                "ingredients": [_resolve_ingredient_for_save(ing) for ing in step.ingredients],
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


def _resolve_ingredient_for_save(ing) -> dict:
    """Resolve a builder ingredient row to the structured RPC payload.

    Looks up the unit by alias, computes canonical quantities, and falls back
    to ``unitId=None`` when the raw unit is unknown so the row still saves
    (the freeform string lives on in ``originalText``).
    """
    unit_def = parse_unit(ing.unit)
    canonical_ml, canonical_g = to_canonical(ing.amount, unit_def)
    return {
        "name": ing.name.strip(),
        "amount": ing.amount,
        "unit": ing.unit,
        "unitId": unit_def.id if unit_def else None,
        "originalText": (ing.originalText or f"{ing.amount} {ing.unit} {ing.name}").strip(),
        "canonicalMl": canonical_ml,
        "canonicalG": canonical_g,
    }


@router.get("/sauces")
async def list_all_sauces():
    """Public endpoint: all sauces with full steps, ingredients, and compatible carbs."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces_full", {}).execute()
    if result.data is None:
        return []
    return result.data


@router.get(
    "/items",
    response_model=ItemsGroupedResponse,
    status_code=200,
    summary="All dish items grouped by category with nested variants",
)
async def list_items() -> dict:
    """Public read of carbs/proteins/salads parents with nested variants."""
    sb = get_supabase()
    result = sb.table("sauceboss_items").select(
        "id,category,parent_id,name,emoji,description,sort_order,"
        "cook_time_minutes,instructions,water_ratio,portion_per_person,portion_unit"
    ).order("sort_order").order("name").execute()
    return _shape_items_grouped(result.data or [])


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


# ── URL import + units/foods registry ────────────────────────────────────────

_SCRAPE_ERROR_STATUS: dict[ScrapeErrorKind, int] = {
    ScrapeErrorKind.INVALID_URL: 422,
    ScrapeErrorKind.NETWORK: 502,
    ScrapeErrorKind.NO_STRUCTURED_DATA: 422,
    ScrapeErrorKind.UNSUPPORTED_SITE: 422,
    ScrapeErrorKind.UNKNOWN: 500,
}


@router.post(
    "/import",
    response_model=ParsedRecipeResponse,
    status_code=200,
    summary="Parse a recipe URL into a draft (does not persist)",
)
async def import_recipe(body: ImportRecipeRequest) -> ParsedRecipeResponse:
    """Fetch ``url``, run schema.org JSON-LD extraction, return a draft.

    The draft is shaped for the builder UI to populate its existing form. The
    user reviews / edits the parsed ingredients and submits via ``POST
    /sauces`` to persist. Failures map to 422 (bad URL / no structured data /
    unsupported site) or 502 (network).
    """
    try:
        parsed = scrape_recipe(str(body.url))
    except ScrapeError as e:
        status = _SCRAPE_ERROR_STATUS.get(e.kind, 500)
        raise HTTPException(status, {"kind": str(e.kind), "message": e.message})

    return ParsedRecipeResponse(
        name=parsed.name,
        description=parsed.description,
        totalTimeMinutes=parsed.total_time_minutes,
        yieldServings=parsed.yield_servings,
        instructions=parsed.instructions,
        ingredients=[
            ParsedIngredientResponse(
                originalText=ing.original_text,
                quantity=ing.quantity,
                unitRaw=ing.unit_raw,
                unitId=(parse_unit(ing.unit_raw).id if parse_unit(ing.unit_raw) else None),
                foodRaw=ing.food_raw,
                canonicalMl=ing.canonical_ml,
                canonicalG=ing.canonical_g,
                note=ing.note,
            )
            for ing in parsed.ingredients
        ],
        sourceUrl=parsed.source_url,
        canonicalUrl=parsed.canonical_url,
    )


@router.get(
    "/units",
    response_model=UnitsListResponse,
    summary="Registry of supported units (for builder dropdown + frontend formatter)",
)
async def list_units() -> UnitsListResponse:
    """Returns every unit the backend can resolve, with canonical conversion factors."""
    rows = [
        UnitRow(
            id=u.id,
            name=u.name,
            plural=u.plural,
            abbreviation=u.abbreviation,
            pluralAbbreviation=u.plural_abbreviation,
            dimension=u.dimension,
            mlPerUnit=u.ml_per_unit,
            gPerUnit=u.g_per_unit,
        )
        for u in UNIT_REGISTRY.values()
    ]
    return UnitsListResponse(units=rows)


@router.get(
    "/foods",
    response_model=FoodsListResponse,
    summary="Foods typeahead — substring match on name",
)
async def list_foods(
    q: str = Query("", description="Substring to match (case-insensitive). Empty returns the first 50 foods alphabetically."),
    limit: int = Query(20, ge=1, le=100, description="Max foods to return."),
) -> FoodsListResponse:
    """Foods typeahead for the recipe builder's ingredient name field."""
    sb = get_supabase()
    query = sb.table("sauceboss_foods").select("id,name,plural")
    needle = q.strip().lower()
    if needle:
        query = query.ilike("name_normalized", f"%{needle}%")
    result = query.order("name").limit(limit).execute()
    rows = result.data or []
    foods = [FoodRow(id=r["id"], name=r["name"], plural=r.get("plural")) for r in rows]
    return FoodsListResponse(foods=foods)


@router.get(
    "/foods-with-usage",
    response_model=FoodsWithUsageResponse,
    summary="All foods with recipe usage counts (Sauce Manager → Ingredients tab)",
)
async def list_foods_with_usage() -> FoodsWithUsageResponse:
    """Returns every food with usageCount (step rows referencing it) and sauceCount (distinct sauces)."""
    rows = _rpc_or_500("list_sauceboss_foods_with_usage", {}, "foods-with-usage")
    return FoodsWithUsageResponse(foods=rows or [])
