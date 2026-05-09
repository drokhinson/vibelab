"""Pydantic request/response models for PlantPlanner API."""

from typing import List, Optional
from pydantic import BaseModel

from .constants import GardenType, ShadeLevel, PlantingSeason, WaterPlan


class MeResponse(BaseModel):
    user_id: str
    display_name: str
    is_admin: bool = False


class CreateGardenBody(BaseModel):
    """Body for POST /gardens.

    grid_width / grid_height are stored in INCHES when garden_type is one of
    {indoor_pot, indoor_planter_box, outdoor_pot, outdoor_planter_box} and in
    FEET otherwise (greenhouse, garden_bed, raised_bed). The frontend feeds
    raw values; backend normalizes to feet at validation time. See
    `garden_units.py` for the helpers that enforce this invariant.
    """
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
    """Cache-backed placement.

    pos_x / pos_y / radius_feet are ALWAYS in feet, regardless of the
    garden's garden_type. The backend converts the garden's stored
    grid_width / grid_height to feet (via `garden_units.grid_dim_to_feet`)
    before bounds-checking, since those fields are inches for pot / planter-box
    types and feet for greenhouse / bed types.
    """
    plant_cache_id: str
    pos_x: float
    pos_y: float
    radius_feet: float


class SavePlantsBody(BaseModel):
    plants: List[PlantPlacement]
