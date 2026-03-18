"""Pydantic request body models for PlantPlanner API."""

from typing import Optional, List
from pydantic import BaseModel

from .constants import GardenType, ShadeLevel, PlantingSeason


class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None


class LoginBody(BaseModel):
    username: str
    password: str


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
