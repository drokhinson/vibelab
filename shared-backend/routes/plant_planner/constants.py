"""Shared constants for PlantPlanner API."""

from enum import StrEnum


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
