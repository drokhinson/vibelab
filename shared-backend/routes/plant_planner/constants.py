"""Shared constants for PlantPlanner API."""

from enum import StrEnum


class GardenType(StrEnum):
    # Indoor (climate-controlled, dimensions in inches except greenhouse)
    INDOOR_POT = "indoor_pot"
    INDOOR_PLANTER_BOX = "indoor_planter_box"
    GREENHOUSE = "greenhouse"
    # Outdoor (climate-exposed; pots/planter-boxes in inches, beds in feet)
    OUTDOOR_POT = "outdoor_pot"
    OUTDOOR_PLANTER_BOX = "outdoor_planter_box"
    GARDEN_BED = "garden_bed"
    RAISED_BED = "raised_bed"


class ShadeLevel(StrEnum):
    FULL_SUN = "full_sun"
    PARTIAL = "partial"
    SHADE = "shade"


class WaterPlan(StrEnum):
    REGULAR = "regular"
    OCCASIONAL = "occasional"
    RAIN_ONLY = "rain_only"


class PlantingSeason(StrEnum):
    SPRING = "spring"
    SUMMER = "summer"
    FALL = "fall"
    WINTER = "winter"


class Lifecycle(StrEnum):
    ANNUAL = "annual"
    BIENNIAL = "biennial"
    PERENNIAL = "perennial"


class UserPlantStatus(StrEnum):
    """Status of a row in plantplanner_user_plants — the user's library."""
    CURRENT = "current"
    FORMER = "former"
    WISHLIST = "wishlist"
