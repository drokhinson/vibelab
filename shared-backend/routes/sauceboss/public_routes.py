"""Public SauceBoss API routes — unified items + sauces."""

import logging
import re
import secrets

from fastapi import Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from db import get_supabase
from shared_models import HealthResponse
from . import router
from .dependencies import CurrentUser, get_current_user
from .models import (
    Attachment,
    CreateSauceRequest,
    ForkResponse,
    IngredientRow,
    IngredientsListResponse,
    IngredientsWithUsageResponse,
    ImportRecipeRequest,
    InitialLoadResponse,
    ItemLoadResponse,
    ItemsGroupedResponse,
    MessageResponse,
    ParsedIngredientResponse,
    ParsedRecipeResponse,
    UnitRow,
    UnitsListResponse,
    UpdateSauceRequest,
    _shape_items_grouped,
)
from .parser import ScrapeError, ScrapeErrorKind, scrape_recipe
from .units import UNIT_REGISTRY, parse_unit, to_canonical

logger = logging.getLogger("sauceboss")


@router.get("/health", response_model=HealthResponse, summary="SauceBoss health check")
async def health():
    """Health check."""
    return {"project": "sauceboss", "status": "ok"}


@router.get(
    "/ingredient-categories",
    response_model=dict[str, str],
    status_code=200,
    summary="Map of ingredient name → category (one round-trip; reads ingredient.category)",
)
async def list_ingredient_categories() -> dict[str, str]:
    """Returns {ingredient_name: category} for the filter-panel grouping.

    Streamlined post-013: reads sauceboss_ingredient.category directly, no
    join. Skips uncategorized rows so the response stays small.
    """
    sb = get_supabase()
    result = (
        sb.table("sauceboss_ingredient")
        .select("name,category")
        .neq("category", "uncategorized")
        .execute()
    )
    return {row["name"]: row["category"] for row in (result.data or [])}


@router.get(
    "/substitutions",
    response_model=dict[str, list[str]],
    status_code=200,
    summary="Map of ingredient name → substitute names (reads ingredient.substitutions)",
)
async def list_substitutions() -> dict[str, list[str]]:
    """Returns {ingredient_name: [substitute_names]} from the consolidated column."""
    sb = get_supabase()
    result = (
        sb.table("sauceboss_ingredient")
        .select("name,substitutions")
        .not_.is_("substitutions", "null")
        .execute()
    )
    return {row["name"]: row["substitutions"] for row in (result.data or []) if row.get("substitutions")}


@router.post("/sauces", status_code=201, summary="Create a user-submitted sauce")
async def create_sauce(
    body: CreateSauceRequest,
    user: CurrentUser = Depends(get_current_user),
):
    """Create a user-submitted sauce with steps, ingredients, and item pairings.

    Sauce-to-dish targeting goes through `attachments` (preferred) or the
    legacy `itemIds` (mapped to dish-level attachments). The sauce_type's
    pairing rule (sauce + dip → carb, marinade → protein, dressing → salad)
    is enforced by the sauceboss_sauce_to_dish_check trigger.

    The new sauce is automatically added to the author's saucebook so it
    appears in their Saucebook tab without an extra round-trip.
    """
    _ensure_attachments(body)
    slug = re.sub(r'[^a-z0-9]+', '-', body.name.lower()).strip('-')
    sauce_id = f"user-{slug}-{secrets.token_hex(2)}"

    if body.parentSauceId:
        _validate_parent_sauce(body.parentSauceId, sauce_id)

    payload = _build_sauce_payload(sauce_id, body, created_by=user.user_id)

    sb = get_supabase()
    try:
        result = sb.rpc("create_sauceboss_sauce", {"p_data": payload}).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    if result.data is None:
        raise HTTPException(500, "Failed to create sauce — RPC returned null")

    # Auto-add to author's saucebook (idempotent).
    try:
        sb.table("sauceboss_user_saucebook").upsert(
            {"user_id": user.user_id, "sauce_id": sauce_id},
            on_conflict="user_id,sauce_id",
        ).execute()
    except Exception:
        logger.exception("create_sauce: failed to auto-add %s to saucebook for %s", sauce_id, user.user_id)

    return {"id": result.data, "status": "created"}


@router.patch(
    "/sauces/{sauce_id}",
    response_model=MessageResponse | ForkResponse,
    status_code=200,
    summary="Update a sauce (owner / admin = in-place; non-owner = fork into a variant)",
)
async def update_sauce(
    body: UpdateSauceRequest,
    sauce_id: str = Path(..., description="Target sauce id"),
    user: CurrentUser = Depends(get_current_user),
):
    """Edit a sauce.

    Three cases:
      * Author or admin → in-place edit (existing flow).
      * Non-owner with a saucebook entry → fork into a variant under the
        family root, owned by the caller. The caller's saucebook row is
        repointed to the new variant atomically; response includes the new
        id as `forkedId`.
      * Non-owner without a saucebook entry → 403; clients must add to
        saucebook before editing.
    """
    _ensure_attachments(body)
    sb = get_supabase()
    existing = (
        sb.table("sauceboss_sauce")
        .select("id, created_by, parent_sauce_id, sauce_type")
        .eq("id", sauce_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Sauce not found")
    row = existing.data[0]

    is_owner = row.get("created_by") == user.user_id
    if user.is_admin or is_owner:
        if body.parentSauceId:
            _validate_parent_sauce(body.parentSauceId, sauce_id)
        payload = _build_sauce_payload(sauce_id, body, created_by=None)
        try:
            result = sb.rpc("update_sauceboss_sauce", {"p_data": payload}).execute()
        except Exception as e:
            raise HTTPException(500, f"Database error: {str(e)}")
        if result.data is None:
            raise HTTPException(500, "Failed to update sauce — RPC returned null")
        return MessageResponse(message="Sauce updated")

    # Non-owner: must have it in their saucebook to edit.
    sb_row = (
        sb.table("sauceboss_user_saucebook")
        .select("user_id")
        .eq("user_id", user.user_id)
        .eq("sauce_id", sauce_id)
        .execute()
    )
    if not sb_row.data:
        raise HTTPException(
            status_code=403,
            detail="Add this recipe to your saucebook before editing — it will be saved as a variant of the original.",
        )

    # Build a fresh-id payload (the RPC mints one if id is empty/missing).
    fork_payload = _build_sauce_payload(sauce_id="", body=body, created_by=user.user_id)
    fork_payload.pop("id", None)

    try:
        new_id = sb.rpc(
            "fork_sauceboss_sauce",
            {
                "p_source_id": sauce_id,
                "p_user": user.user_id,
                "p_data": fork_payload,
            },
        ).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    if new_id.data is None:
        raise HTTPException(500, "Fork RPC returned no id")
    return ForkResponse(message="Forked into your saucebook as a variant", forkedId=new_id.data)


@router.delete(
    "/sauces/{sauce_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a sauce (owner or admin only)",
)
async def delete_sauce(
    sauce_id: str = Path(..., description="Target sauce id"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a sauce; steps, ingredients, and sauce_to_dish rows cascade via FK."""
    sb = get_supabase()
    existing = (
        sb.table("sauceboss_sauce").select("id, created_by").eq("id", sauce_id).execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Sauce not found")
    row = existing.data[0]
    if not user.is_admin and row.get("created_by") != user.user_id:
        raise HTTPException(status_code=403, detail="You can only delete your own sauces")

    try:
        sb.table("sauceboss_sauce").delete().eq("id", sauce_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {str(e)}")
    return MessageResponse(message="Sauce deleted")


def _ensure_attachments(body: CreateSauceRequest) -> None:
    """Populate `attachments` from the legacy `itemIds` if needed; reject empty.

    Full-recipe sauces are standalone and intentionally have no attachments —
    the sauceboss_sauce_to_dish_check trigger rejects any attachment row for
    them, so we also clear out anything the client may have sent in error.
    """
    if str(body.sauceType) == "full_recipe":
        body.attachments = []
        body.itemIds = []
        return
    if not body.attachments:
        if body.itemIds:
            body.attachments = [Attachment(kind="dish", value=v) for v in body.itemIds]
    if not body.attachments and not body.itemIds:
        raise HTTPException(
            status_code=422,
            detail="Sauce must attach to at least one category, dish, or subtype.",
        )


def _build_sauce_payload(sauce_id: str, body: CreateSauceRequest, created_by: str | None) -> dict:
    """Shape a CreateSauce/UpdateSauce body into the RPC payload dict."""
    payload: dict = {
        "id": sauce_id,
        "name": body.name,
        "cuisine": body.cuisine,
        "cuisineEmoji": body.cuisineEmoji,
        "color": body.color,
        "description": body.description,
        "sourceUrl": body.sourceUrl,
        "defaultServings": body.defaultServings,
        "sauceType": body.sauceType,
        "parentSauceId": body.parentSauceId,
        "attachments": [{"kind": str(a.kind), "value": a.value} for a in body.attachments],
        "itemIds": body.itemIds,
        "steps": [
            {
                "title": step.title,
                "instructions": (step.instructions or "").strip() or None,
                "stepOrder": idx + 1,
                "inputFromStep": step.inputFromStep if step.inputFromStep else (step.inputFromSteps[0] if step.inputFromSteps else None),
                "inputFromSteps": step.inputFromSteps if step.inputFromSteps else ([step.inputFromStep] if step.inputFromStep else []),
                "estimatedTime": step.estimatedTime,
                "ingredients": [_resolve_ingredient_for_save(ing) for ing in step.ingredients],
            }
            for idx, step in enumerate(body.steps)
        ],
    }
    if created_by is not None:
        payload["createdBy"] = created_by
    return payload


def _validate_parent_sauce(parent_id: str, sauce_id: str) -> None:
    """Reject self-reference and variant-of-variant links with a friendly 400.

    The DB trigger catches both cases too, but raising here gives a cleaner
    error than surfacing the Postgres exception verbatim.
    """
    if parent_id == sauce_id:
        raise HTTPException(status_code=400, detail="A sauce cannot be a variant of itself")
    sb = get_supabase()
    parent = (
        sb.table("sauceboss_sauce")
        .select("id, parent_sauce_id")
        .eq("id", parent_id)
        .execute()
    )
    if not parent.data:
        raise HTTPException(status_code=400, detail=f"Parent sauce {parent_id} not found")
    if parent.data[0].get("parent_sauce_id"):
        raise HTTPException(
            status_code=400,
            detail="Cannot create a variant of another variant — pick the original sauce instead",
        )


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


@router.get(
    "/sauces",
    response_model=list[dict],
    status_code=200,
    summary="List all sauces with full steps, ingredients, and compatible items",
)
async def list_all_sauces() -> list[dict]:
    """Public endpoint: all sauces with full steps, ingredients, and compatible carbs.

    The RPC return shape mirrors the per-sauce envelope built by
    ``get_sauceboss_all_sauces_full`` and consumed directly by the web /
    native clients; the OpenAPI shape is left as ``list[dict]`` to match the
    existing convention used by ``InitialLoadResponse`` and friends.
    """
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_all_sauces_full", {}).execute()
    return result.data or []


@router.get(
    "/cuisines",
    response_model=list[dict],
    status_code=200,
    summary="Distinct cuisines across all sauces, with emoji from cuisine_info",
)
async def list_cuisines() -> list[dict]:
    """Returns every distinct cuisine that appears on at least one sauce, plus
    its emoji from ``sauceboss_cuisine_info`` (falls back to a generic icon
    when the cuisine has no entry in the lookup table)."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_distinct_cuisines", {}).execute()
    return result.data or []


@router.get(
    "/filter-dishes",
    response_model=list[dict],
    status_code=200,
    summary="Dishes that are targeted by at least one sauce (for filter UI)",
)
async def list_filter_dishes() -> list[dict]:
    """Returns dish-level items that appear in ``sauceboss_sauce_to_dish``
    with ``target_kind='dish'``.  Used by the Browse / Saucebook filter
    panels — only dishes with ≥1 linked sauce are included so the UI
    never shows an empty-result chip."""
    sb = get_supabase()
    result = sb.rpc("get_sauceboss_filter_dishes", {}).execute()
    return result.data or []


@router.get(
    "/items",
    response_model=ItemsGroupedResponse,
    status_code=200,
    summary="All dish items grouped by category with nested variants",
)
async def list_items() -> dict:
    """Public read of carbs/proteins/salads parents with nested subtypes."""
    sb = get_supabase()
    result = sb.table("sauceboss_dish").select(
        "id,category,parent_id,dish_level,name,emoji,description,sort_order,"
        "cook_time_minutes,instructions,water_ratio,portion_per_person,portion_unit"
    ).order("sort_order").order("name").execute()
    return _shape_items_grouped(result.data or [])


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
                ingredientRaw=ing.food_raw,
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
    "/ingredients",
    response_model=IngredientsListResponse,
    summary="Ingredient typeahead — substring match on name",
)
async def list_ingredients(
    q: str = Query("", description="Substring to match (case-insensitive). Empty returns the first 50 ingredients alphabetically."),
    limit: int = Query(20, ge=1, le=100, description="Max ingredients to return."),
) -> IngredientsListResponse:
    """Ingredient typeahead for the recipe builder's ingredient name field."""
    sb = get_supabase()
    query = sb.table("sauceboss_ingredient").select("id,name,plural,category,substitutions")
    needle = q.strip().lower()
    if needle:
        query = query.ilike("name_normalized", f"%{needle}%")
    result = query.order("name").limit(limit).execute()
    rows = result.data or []
    ingredients = [
        IngredientRow(
            id=r["id"],
            name=r["name"],
            plural=r.get("plural"),
            category=r.get("category"),
            substitutions=r.get("substitutions"),
        )
        for r in rows
    ]
    return IngredientsListResponse(ingredients=ingredients)


@router.get(
    "/ingredients-with-usage",
    response_model=IngredientsWithUsageResponse,
    summary="All ingredients with recipe usage counts (Sauce Manager → Ingredients tab)",
)
async def list_ingredients_with_usage() -> IngredientsWithUsageResponse:
    """Returns every ingredient with usageCount (step rows) and sauceCount (distinct sauces)."""
    rows = _rpc_or_500("list_sauceboss_ingredients_with_usage", {}, "ingredients-with-usage")
    return IngredientsWithUsageResponse(ingredients=rows or [])


# ── release/sauceboss-1.0 compat shims ─────────────────────────────────────
# The release-branch web/native still call /foods, /foods-with-usage, and
# POST /ingredient-categories. These thin aliases reshape responses to the
# legacy `{foods: [...]}` envelope and forward category writes into the
# consolidated sauceboss_ingredient.category column. Remove once the release
# is retired.

class _LegacyFoodsListResponse(BaseModel):
    """Legacy `{foods: [...]}` envelope expected by release/sauceboss-1.0."""
    foods: list[dict]


@router.get(
    "/foods",
    response_model=_LegacyFoodsListResponse,
    summary="[compat] Ingredient typeahead (release/sauceboss-1.0 alias of /ingredients)",
)
async def list_foods_compat(
    q: str = Query("", description="Substring to match (case-insensitive)."),
    limit: int = Query(20, ge=1, le=100, description="Max ingredients to return."),
) -> _LegacyFoodsListResponse:
    """Alias of /ingredients — strips the post-013 fields the release doesn't read."""
    sb = get_supabase()
    query = sb.table("sauceboss_ingredient").select("id,name,plural")
    needle = q.strip().lower()
    if needle:
        query = query.ilike("name_normalized", f"%{needle}%")
    result = query.order("name").limit(limit).execute()
    return _LegacyFoodsListResponse(foods=result.data or [])


@router.get(
    "/foods-with-usage",
    response_model=_LegacyFoodsListResponse,
    summary="[compat] Ingredients with usage (release/sauceboss-1.0 alias of /ingredients-with-usage)",
)
async def list_foods_with_usage_compat() -> _LegacyFoodsListResponse:
    """Alias of /ingredients-with-usage with the legacy `{foods: [...]}` envelope."""
    rows = _rpc_or_500("list_sauceboss_ingredients_with_usage", {}, "foods-with-usage(compat)")
    return _LegacyFoodsListResponse(foods=rows or [])


class _IngredientCategoryInput(BaseModel):
    """release/sauceboss-1.0 POST /ingredient-categories body."""
    ingredientName: str = Field(min_length=1)
    category: str = Field(min_length=1)


@router.post(
    "/ingredient-categories",
    response_model=MessageResponse,
    status_code=200,
    summary="[compat] Set an ingredient's category (release/sauceboss-1.0 shim over upsert RPC)",
)
async def upsert_ingredient_category_compat(body: _IngredientCategoryInput) -> MessageResponse:
    """Forward to upsert_sauceboss_ingredient_category. No-op if the named ingredient is absent."""
    sb = get_supabase()
    sb.rpc("upsert_sauceboss_ingredient_category", {
        "p_ingredient_name": body.ingredientName.strip().lower(),
        "p_category": body.category,
    }).execute()
    return MessageResponse(message="ok")
