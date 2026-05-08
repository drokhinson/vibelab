"""Shared constants for PlantPlanner API."""

from enum import StrEnum


class GardenType(StrEnum):
    INDOOR = "indoor"
    OUTDOOR = "outdoor"
    GARDEN_BED = "garden_bed"
    RAISED_BED = "raised_bed"
    GREENHOUSE = "greenhouse"


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
