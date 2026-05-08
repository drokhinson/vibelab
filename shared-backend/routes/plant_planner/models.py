"""Pydantic request/response models for PlantPlanner API."""

from typing import Any, List, Optional
from pydantic import BaseModel

from .constants import GardenType, ShadeLevel, PlantingSeason


class MeResponse(BaseModel):
    user_id: str
    display_name: str
    is_admin: bool = False


class UsdaZoneRange(BaseModel):
    min: int
    max: int


class CreateGardenBody(BaseModel):
    name: str = "My Garden"
    grid_width: int = 4
    grid_height: int = 4
    garden_type: GardenType = GardenType.GARDEN_BED
    shade_level: ShadeLevel = ShadeLevel.FULL_SUN
    planting_season: PlantingSeason = PlantingSeason.SPRING
    usda_zone: Optional[str] = None


class UpdateGardenBody(BaseModel):
    name: Optional[str] = None
    grid_width: Optional[int] = None
    grid_height: Optional[int] = None
    garden_type: Optional[GardenType] = None
    shade_level: Optional[ShadeLevel] = None
    planting_season: Optional[PlantingSeason] = None
    usda_zone: Optional[str] = None
    settings_json: Optional[dict] = None


class GardenResponse(BaseModel):
    id: str
    user_id: str
    name: str
    grid_width: int
    grid_height: int
    garden_type: GardenType
    shade_level: ShadeLevel
    planting_season: PlantingSeason
    usda_zone: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class PlantResponse(BaseModel):
    id: str
    name: str
    category: str
    height_inches: int
    spread_inches: int
    sunlight: str
    bloom_season: List[str] = []
    bloom_months: List[int] = []
    native: bool = False
    usda_zones: Optional[UsdaZoneRange] = None
    pollinator_attracts: List[str] = []
    water_need: str = "medium"
    care_summary: Optional[str] = None
    description: Optional[str] = None
    render_key: Optional[str] = None
    sort_order: int = 0
    render_params: Optional[Any] = None
    render_colors: Optional[Any] = None
    render_label: Optional[str] = None


class PlantPlacement(BaseModel):
    plant_id: str
    grid_x: int
    grid_y: int


class SavePlantsBody(BaseModel):
    plants: List[PlantPlacement]


class CompanionResponse(BaseModel):
    plant_a_id: str
    plant_b_id: str
    relationship: str
    reason: str
