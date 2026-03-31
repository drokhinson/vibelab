"""Constants and enums for BoardgameBuddy."""

from enum import StrEnum


class CollectionStatus(StrEnum):
    OWNED = "owned"
    PLAYED = "played"
    WISHLIST = "wishlist"


# Default theme colors by primary category (fallback when game has no theme_color)
CATEGORY_COLORS: dict[str, str] = {
    "Strategy": "#8B6914",
    "Card Game": "#2E5A3C",
    "Party": "#D4457D",
    "Family": "#4A90D9",
    "War": "#6B3A3A",
    "Abstract": "#555555",
    "Thematic": "#7B3FA0",
    "Economic": "#B8860B",
    "default": "#6C63FF",
}
