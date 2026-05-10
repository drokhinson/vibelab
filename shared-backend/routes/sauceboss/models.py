"""Pydantic request/response models for SauceBoss."""

import logging
from datetime import datetime
from enum import StrEnum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, HttpUrl

logger = logging.getLogger("sauceboss")


# ── User accounts (migration 003) ─────────────────────────────────────────────

class ProfileCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=60)


class ProfileResponse(BaseModel):
    id: str
    display_name: str
    avatar_url: Optional[str] = None
    is_admin: bool = False
    created_at: Optional[datetime] = None


class AdminKeyBody(BaseModel):
    admin_key: str = Field(min_length=1)


class FavoriteEntry(BaseModel):
    """One entry in the legacy favorites response (release/sauceboss-1.0 compat).

    Backed by sauceboss_user_saucebook post-013; ``createdAt`` mirrors
    ``added_at`` so the release-branch UI keeps sorting correctly.
    """
    sauceId: str
    createdAt: Optional[str] = None


class FavoriteListResponse(BaseModel):
    favorites: List[FavoriteEntry]


class MessageResponse(BaseModel):
    message: str


class ItemCategory(StrEnum):
    CARB = "carb"
    PROTEIN = "protein"
    SALAD = "salad"


class SauceType(StrEnum):
    SAUCE = "sauce"
    DRESSING = "dressing"
    MARINADE = "marinade"
    DIP = "dip"
    # Standalone recipe — not paired with any dish category. Attachment rows
    # are rejected by sauceboss_sauce_to_dish_check.
    FULL_RECIPE = "full_recipe"


class AttachmentKind(StrEnum):
    CATEGORY = "category"
    DISH = "dish"
    SUBTYPE = "subtype"


class Attachment(BaseModel):
    """One attachment row on a sauce.

    `kind='category'` → `value` is one of carb/protein/salad. The sauce applies
    to every dish + subtype in that category.
    `kind='dish'` → `value` is a sauceboss_dish.id at dish_level='dish'.
    Applies to that dish + its subtypes.
    `kind='subtype'` → `value` is a sauceboss_dish.id at dish_level='subtype'.
    Applies to that subtype only.
    """
    kind: AttachmentKind
    value: str = Field(min_length=1)


class DishLevel(StrEnum):
    DISH = "dish"
    SUBTYPE = "subtype"


# ── Sauce creation ────────────────────────────────────────────────────────────

class IngredientInput(BaseModel):
    """One ingredient row.

    The frontend sends ``name`` (ingredient display string) and ``unit`` (raw unit
    string — abbreviation or alias). The backend resolves these to ``ingredient_id``
    and ``unit_id`` via the ingredient/unit lookup tables before persisting; rows
    that don't resolve (e.g. typos) keep ``original_text`` for cleanup.

    ``amount`` accepts 0 so qualitative rows ("to taste") can save without a
    numeric quantity — the unit registry resolves "to taste" to its unit_id
    and the recipe view renders the originalText instead of "0 to taste".
    """
    name: str = Field(min_length=1)
    amount: float = Field(ge=0)
    unit: str = Field(min_length=1)
    originalText: Optional[str] = None


class StepInput(BaseModel):
    title: str = Field(min_length=1)
    instructions: Optional[str] = None
    ingredients: List[IngredientInput] = Field(min_length=1)
    inputFromStep: int | None = None
    estimatedTime: int | None = Field(default=None, ge=0, le=600)


class CreateSauceRequest(BaseModel):
    """Sauce create/update payload.

    Targeting: send `attachments` (preferred) — a list of {kind, value} rows
    pointing at category, dish, or subtype targets. The legacy `itemIds`
    field is still accepted for one release: each entry is treated as a
    dish-level attachment. The route validates that at least one of the two
    is non-empty.
    """
    name: str = Field(min_length=1, max_length=80)
    cuisine: str = Field(min_length=1)
    cuisineEmoji: str = ""
    color: str = Field(pattern=r'^#[0-9A-Fa-f]{6}$')
    description: str = ""
    sourceUrl: Optional[str] = None
    sauceType: SauceType = SauceType.SAUCE
    parentSauceId: Optional[str] = None
    attachments: List[Attachment] = Field(default_factory=list)
    itemIds: List[str] = Field(default_factory=list)
    steps: List[StepInput] = Field(min_length=1)


class UpdateSauceRequest(CreateSauceRequest):
    """Same shape as CreateSauceRequest; the path param identifies the sauce."""
    pass


class ForkResponse(BaseModel):
    """Returned from PATCH /sauces/{id} when the editor is not the owner.

    The original sauce is unchanged; a new variant was created under the
    family root with `created_by = caller`, and the caller's saucebook row
    was repointed from the original sauce id to `forkedId`.
    """
    message: str
    forkedId: str


class AssignVariantsRequest(BaseModel):
    """Bulk-assign existing sauces as variants of a single parent.

    Used by the sauce-manager merge UI to retro-link multiple sauces to a
    parent in one round-trip. Each ``sauceIds`` entry must currently be a
    root (``parent_sauce_id IS NULL``) and have no variants of its own; the
    backend validates these before issuing the update.
    """
    sauceIds: List[str] = Field(min_length=1)


# ── URL import ────────────────────────────────────────────────────────────────

class ImportRecipeRequest(BaseModel):
    """Recipe-import request body — a single URL pointing at a recipe page."""
    url: HttpUrl


class ParsedIngredientResponse(BaseModel):
    """One ingredient row in an import preview."""
    originalText: str
    quantity: Optional[float] = None
    unitRaw: Optional[str] = None
    unitId: Optional[str] = None
    ingredientRaw: str
    canonicalMl: Optional[float] = None
    canonicalG: Optional[float] = None
    note: Optional[str] = None


class ParsedRecipeResponse(BaseModel):
    """Import preview returned by ``POST /import``.

    Shape mirrors :class:`CreateSauceRequest` partially so the frontend can map
    the preview into the existing builder form fields. We do NOT persist this
    — the user reviews + edits, then submits via ``POST /sauces``.
    """
    name: str
    description: str = ""
    totalTimeMinutes: Optional[int] = None
    yieldServings: Optional[int] = None
    instructions: List[str] = Field(default_factory=list)
    ingredients: List[ParsedIngredientResponse] = Field(default_factory=list)
    sourceUrl: str
    canonicalUrl: Optional[str] = None


# ── Units / foods registry ────────────────────────────────────────────────────

class UnitDimensionEnum(StrEnum):
    VOLUME = "volume"
    MASS = "mass"
    COUNT = "count"


class UnitRow(BaseModel):
    id: str
    name: str
    plural: str
    abbreviation: str
    pluralAbbreviation: str
    dimension: UnitDimensionEnum
    mlPerUnit: Optional[float] = None
    gPerUnit: Optional[float] = None


class UnitsListResponse(BaseModel):
    units: List[UnitRow]


class IngredientRow(BaseModel):
    id: str
    name: str
    plural: Optional[str] = None
    category: Optional[str] = None
    substitutions: Optional[List[str]] = None


class IngredientsListResponse(BaseModel):
    ingredients: List[IngredientRow]


# ── Ingredient admin ─────────────────────────────────────────────────────────

class IngredientWithUsageRow(BaseModel):
    id: str
    name: str
    plural: Optional[str] = None
    category: Optional[str] = None
    substitutions: Optional[List[str]] = None
    usageCount: int
    sauceCount: int
    createdAt: Optional[str] = None


class IngredientsWithUsageResponse(BaseModel):
    ingredients: List[IngredientWithUsageRow]


class CreateIngredientRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    plural: Optional[str] = Field(default=None, max_length=80)
    category: Optional[str] = Field(default=None, max_length=40)


class UpdateIngredientRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    plural: Optional[str] = Field(default=None, max_length=80)
    category: Optional[str] = Field(default=None, max_length=40)
    substitutions: Optional[List[str]] = None


class MergeIngredientsRequest(BaseModel):
    keepId: str = Field(min_length=1)
    mergeIds: List[str] = Field(min_length=1)


# ── Admin ─────────────────────────────────────────────────────────────────────

class CreateItemRequest(BaseModel):
    category: ItemCategory
    parentId: Optional[str] = None
    name: str = Field(min_length=1, max_length=60)
    emoji: str = Field(min_length=1)
    description: str = ""
    sortOrder: int = 0
    cookTimeMinutes: Optional[int] = None
    instructions: Optional[str] = None
    waterRatio: Optional[str] = None
    portionPerPerson: float = Field(gt=0)
    portionUnit: str = Field(min_length=1)


class UpdateItemRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    emoji: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    sortOrder: Optional[int] = None
    cookTimeMinutes: Optional[int] = None
    instructions: Optional[str] = None
    waterRatio: Optional[str] = None
    portionPerPerson: Optional[float] = Field(default=None, gt=0)
    portionUnit: Optional[str] = Field(default=None, min_length=1)


# ── Combined-load responses ──────────────────────────────────────────────────

class InitialLoadResponse(BaseModel):
    carbs: List[Dict[str, Any]]
    proteins: List[Dict[str, Any]]
    saladBases: List[Dict[str, Any]]


class ItemLoadResponse(BaseModel):
    item: Optional[Dict[str, Any]]
    variants: List[Dict[str, Any]]
    sauces: List[Dict[str, Any]]
    ingredients: List[str]


# Note: uses key "salads" (not "saladBases" like InitialLoadResponse) — matches
# the existing dish-tab consumer in projects/sauceboss/web/settings.js.
class ItemsGroupedResponse(BaseModel):
    carbs: List[Dict[str, Any]]
    proteins: List[Dict[str, Any]]
    salads: List[Dict[str, Any]]


# ── Import / Export ──────────────────────────────────────────────────────────

class SauceExportEnvelope(BaseModel):
    """Single-sauce export envelope. Inner mirrors CreateSauceRequest plus the
    read-only fields populated by the RPC (id, createdBy, attachments)."""
    version: int = 1
    exportedAt: str
    sauce: Dict[str, Any]


class BulkSauceExportEnvelope(BaseModel):
    """All-sauces export envelope (admin only). Bulk import is unsupported."""
    version: int = 1
    exportedAt: str
    count: int
    sauces: List[Dict[str, Any]]


# ── Saucebook + Browse + Pantry (migration 010) ──────────────────────────────

class SaucebookResponse(BaseModel):
    """The current user's saucebook — Browse-shaped slim envelopes plus
    saucebook-specific fields (`addedAt`, `ingredientNames`). Steps and the
    full ingredient list are NOT included; the recipe view fetches the full
    envelope via /sauces when the user opens a recipe (see migration 012)."""
    sauces: List[Dict[str, Any]]


class BrowseResponse(BaseModel):
    """Paginated Browse-tab listing.

    `total` is the unfiltered family-root count for the current filter set;
    `items` is the current page of lightweight rows (no steps / ingredients
    — fetch the full envelope from the per-sauce detail endpoint when the
    user opens one).
    """
    total: int
    items: List[Dict[str, Any]]


class AuthorSummary(BaseModel):
    userId: str
    displayName: str
    sauceCount: int


class PantryEntry(BaseModel):
    """One pantry entry. ``foodId`` is a compat alias of ``ingredientId``
    for release/sauceboss-1.0 — both fields carry the same value."""
    ingredientId: str
    foodId: Optional[str] = None  # release-compat alias; populated from ingredientId
    name: str
    missing: bool


class PantryResponse(BaseModel):
    ingredients: List[PantryEntry]
    saucebookSauceIds: List[str]


class SetPantryMissingRequest(BaseModel):
    """Replace the user's pantry-missing set in one round-trip.

    Accepts either ``missingIngredientIds`` (post-013) or ``missingFoodIds``
    (release/sauceboss-1.0 compat). The route resolves to a single list before
    calling the RPC.
    """
    missingIngredientIds: Optional[List[str]] = None
    missingFoodIds: Optional[List[str]] = None  # release-compat alias

    def resolve_ids(self) -> List[str]:
        if self.missingIngredientIds is not None:
            return self.missingIngredientIds
        if self.missingFoodIds is not None:
            return self.missingFoodIds
        return []


def _shape_items_grouped(rows: list[dict]) -> dict:
    """Group raw sauceboss_dish rows into {carbs, proteins, salads} with nested variants.

    Output shape preserves the legacy `variants` array name used by the admin
    UI; each row also carries `dishLevel` so callers can tell a `dish` from a
    `subtype` regardless of nesting. The `variants` array on a dish row
    contains its subtypes.
    """
    def shape(r: dict) -> dict:
        return {
            "id": r["id"],
            "category": r["category"],
            "parentId": r.get("parent_id"),
            "dishLevel": r.get("dish_level") or ("subtype" if r.get("parent_id") else "dish"),
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

    parents_by_id: Dict[str, dict] = {}
    orphan_count = 0
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
            orphan_count += 1
        else:
            parent["variants"].append(shape(r))

    if orphan_count:
        logger.warning("sauceboss: %d variant rows reference missing parents", orphan_count)

    grouped: Dict[str, List[dict]] = {"carbs": [], "proteins": [], "salads": []}
    for parent in parents_by_id.values():
        if parent["category"] == "carb":
            grouped["carbs"].append(parent)
        elif parent["category"] == "protein":
            grouped["proteins"].append(parent)
        elif parent["category"] == "salad":
            grouped["salads"].append(parent)
    return grouped
