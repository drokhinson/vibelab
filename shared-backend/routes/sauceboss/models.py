"""Pydantic request/response models for SauceBoss."""

import logging
from enum import StrEnum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, HttpUrl

logger = logging.getLogger("sauceboss")


class ItemCategory(StrEnum):
    CARB = "carb"
    PROTEIN = "protein"
    SALAD = "salad"


class SauceType(StrEnum):
    SAUCE = "sauce"
    DRESSING = "dressing"
    MARINADE = "marinade"


# ── Sauce creation ────────────────────────────────────────────────────────────

class IngredientInput(BaseModel):
    """One ingredient row.

    The frontend sends ``name`` (food display string) and ``unit`` (raw unit
    string — abbreviation or alias). The backend resolves these to ``food_id``
    and ``unit_id`` via the foods/units lookup tables before persisting; rows
    that don't resolve (e.g. typos) keep ``original_text`` for cleanup.
    """
    name: str = Field(min_length=1)
    amount: float = Field(gt=0)
    unit: str = Field(min_length=1)
    originalText: Optional[str] = None


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
    sauceType: SauceType = SauceType.SAUCE
    itemIds: List[str] = Field(min_length=1)
    steps: List[StepInput] = Field(min_length=1)


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
    foodRaw: str
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


class FoodRow(BaseModel):
    id: str
    name: str
    plural: Optional[str] = None


class FoodsListResponse(BaseModel):
    foods: List[FoodRow]


# ── Ingredient categories ────────────────────────────────────────────────────

class IngredientCategoryInput(BaseModel):
    ingredientName: str = Field(min_length=1)
    category: str = Field(min_length=1)


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


def _shape_items_grouped(rows: list[dict]) -> dict:
    """Group raw sauceboss_items rows into {carbs, proteins, salads} with nested variants."""
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
