"""Pydantic request/response models for SauceBoss."""

from enum import StrEnum
from typing import List, Optional

from pydantic import BaseModel, Field


class AddonType(StrEnum):
    PROTEIN = "protein"
    VEGGIE = "veggie"


class SauceType(StrEnum):
    SAUCE = "sauce"
    DRESSING = "dressing"
    MARINADE = "marinade"


class UnitType(StrEnum):
    VOLUME = "volume"
    WEIGHT = "weight"
    COUNT = "count"


# ── Sauce creation ────────────────────────────────────────────────────────────

class IngredientInput(BaseModel):
    name: str = Field(min_length=1)
    amount: float = Field(gt=0)
    unit: str = Field(min_length=1)
    unit_type: UnitType = UnitType.VOLUME
    original_text: str | None = None


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
    sauce_type: SauceType = SauceType.SAUCE
    servings: int | None = None
    yield_quantity: float | None = None
    yield_unit: str | None = None
    source_url: str | None = None
    source_name: str | None = None


# ── Ingredient categories ────────────────────────────────────────────────────

class IngredientCategoryInput(BaseModel):
    ingredientName: str = Field(min_length=1)
    category: str = Field(min_length=1)


# ── Admin ─────────────────────────────────────────────────────────────────────

class CreateCarbRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str = Field(min_length=1)
    description: str = ""
    cookTimeMinutes: int = 0
    cookTimeLabel: str = ""


class CreateAddonRequest(BaseModel):
    type: AddonType
    name: str = Field(min_length=1)
    emoji: str = Field(min_length=1)
    desc: str = ""
    estimatedTime: int = Field(gt=0)
    instructions: str = Field(min_length=1)
