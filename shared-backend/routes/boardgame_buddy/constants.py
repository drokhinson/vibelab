"""Constants and enums for BoardgameBuddy."""

from enum import StrEnum


class CollectionStatus(StrEnum):
    OWNED = "owned"
    PLAYED = "played"
    WISHLIST = "wishlist"


class CollectionSort(StrEnum):
    ALPHABETICAL = "alphabetical"
    LAST_PLAYED = "last_played"


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

# Cycle through this palette when auto-assigning a color to a newly imported
# expansion. Index = number of existing expansions on the same base game,
# modulo length. Saturated, mutually distinct, contrast-tested against both
# luxury (dark) and parchment (scroll) backgrounds.
EXPANSION_COLOR_PALETTE: list[str] = [
    "#f97316",  # orange
    "#06b6d4",  # cyan
    "#a855f7",  # purple
    "#22c55e",  # green
    "#eab308",  # yellow
    "#ef4444",  # red
    "#ec4899",  # pink
    "#3b82f6",  # blue
]
