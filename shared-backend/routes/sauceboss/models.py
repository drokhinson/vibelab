"""Pydantic request/response models for SauceBoss."""

from typing import List, Optional

from pydantic import BaseModel, Field


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
    carbIds: List[str] = Field(min_length=1)
    steps: List[StepInput] = Field(min_length=1)


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
    type: str = Field(pattern=r'^(protein|veggie)$')
    name: str = Field(min_length=1)
    emoji: str = Field(min_length=1)
    desc: str = ""
    estimatedTime: int = Field(gt=0)
    instructions: str = Field(min_length=1)
