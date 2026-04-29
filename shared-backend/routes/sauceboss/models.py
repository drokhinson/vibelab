"""Pydantic request/response models for SauceBoss."""

from enum import StrEnum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


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
