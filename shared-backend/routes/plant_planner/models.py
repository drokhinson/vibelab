"""Pydantic request/response models for PlantPlanner API."""

from typing import List, Optional
from pydantic import BaseModel

from .constants import GardenType, ShadeLevel, PlantingSeason, WaterPlan


class MeResponse(BaseModel):
    user_id: str
    display_name: str
    is_admin: bool = False


class CreateGardenBody(BaseModel):
    name: str = "My Garden"
    grid_width: int = 4
    grid_height: int = 4
    garden_type: GardenType = GardenType.GARDEN_BED
    shade_level: ShadeLevel = ShadeLevel.FULL_SUN
    planting_season: PlantingSeason = PlantingSeason.SPRING
    water_plan: WaterPlan = WaterPlan.REGULAR
    usda_zone: Optional[str] = None
    location_label: Optional[str] = None


class UpdateGardenBody(BaseModel):
    name: Optional[str] = None
    grid_width: Optional[int] = None
    grid_height: Optional[int] = None
    garden_type: Optional[GardenType] = None
    shade_level: Optional[ShadeLevel] = None
    planting_season: Optional[PlantingSeason] = None
    water_plan: Optional[WaterPlan] = None
    usda_zone: Optional[str] = None
    location_label: Optional[str] = None
    settings_json: Optional[dict] = None
    shortlist_plant_cache_ids: Optional[List[str]] = None


class GardenResponse(BaseModel):
    id: str
    user_id: str
    name: str
    grid_width: int
    grid_height: int
    garden_type: GardenType
    shade_level: ShadeLevel
    planting_season: PlantingSeason
    water_plan: WaterPlan = WaterPlan.REGULAR
    usda_zone: Optional[str] = None
    location_label: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class LocationLookupBody(BaseModel):
    zip: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class LocationLookupResponse(BaseModel):
    zone: str               # e.g. "6a"
    zone_number: int        # numeric prefix, e.g. 6
    label: str              # display label
    source: str             # "zip" | "geolocation"


class PlantPlacement(BaseModel):
    """Cache-backed placement. The legacy `plant_id` field was removed in
    Phase 2 of the plant-first refactor — every placement now points at a
    `plantplanner_plant_cache` row."""
    plant_cache_id: str
    pos_x: float
    pos_y: float
    radius_feet: float


class SavePlantsBody(BaseModel):
    plants: List[PlantPlacement]
