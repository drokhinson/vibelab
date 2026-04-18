"""Pydantic request/response models for PlantPlanner API."""

from typing import Optional, List
from pydantic import BaseModel, Field

from .constants import GardenType, ShadeLevel, PlantingSeason


class ProfileBody(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=80)


class ProfileResponse(BaseModel):
    id: str
    display_name: str
    created_at: str


class CreateGardenBody(BaseModel):
    name: str = "My Garden"
    grid_width: int = 4
    grid_height: int = 4
    garden_type: GardenType = GardenType.GARDEN_BED
    shade_level: ShadeLevel = ShadeLevel.FULL_SUN
    planting_season: PlantingSeason = PlantingSeason.SPRING


class UpdateGardenBody(BaseModel):
    name: Optional[str] = None
    grid_width: Optional[int] = None
    grid_height: Optional[int] = None
    garden_type: Optional[GardenType] = None
    shade_level: Optional[ShadeLevel] = None
    planting_season: Optional[PlantingSeason] = None


class PlantPlacement(BaseModel):
    plant_id: str
    grid_x: int
    grid_y: int


class SavePlantsBody(BaseModel):
    plants: List[PlantPlacement]
