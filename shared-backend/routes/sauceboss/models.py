"""Pydantic request/response models for SauceBoss."""

import logging
from enum import StrEnum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

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
    sauceType: SauceType = SauceType.SAUCE
    itemIds: List[str] = Field(min_length=1)
    steps: List[StepInput] = Field(min_length=1)


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
