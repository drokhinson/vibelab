"""Shared constants for PlantPlanner API."""

import os
from enum import StrEnum

JWT_SECRET = os.environ.get("PLANTPLANNER_JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"


class GardenType(StrEnum):
    GARDEN_BED = "garden_bed"
    PLANTER = "planter"


class ShadeLevel(StrEnum):
    FULL_SUN = "full_sun"
    PARTIAL = "partial"
    SHADE = "shade"


class PlantingSeason(StrEnum):
    SPRING = "spring"
    SUMMER = "summer"
    FALL = "fall"
    WINTER = "winter"
