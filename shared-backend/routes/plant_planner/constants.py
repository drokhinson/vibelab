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
    """Aligned with Perenual v2/species-list `sunlight` filter enum."""
    FULL_SUN = "full_sun"
    SUN_PART_SHADE = "sun-part_shade"
    PART_SHADE = "part_shade"
    FULL_SHADE = "full_shade"


class WaterPlan(StrEnum):
    """Aligned with Perenual v2/species-list `watering` filter enum."""
    FREQUENT = "frequent"
    AVERAGE = "average"
    MINIMUM = "minimum"
    NONE = "none"


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
