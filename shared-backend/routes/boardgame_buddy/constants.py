"""Constants and enums for BoardgameBuddy."""

from enum import StrEnum


class CollectionStatus(StrEnum):
    OWNED = "owned"
    PLAYED = "played"
    WISHLIST = "wishlist"


class CollectionSort(StrEnum):
    ALPHABETICAL = "alphabetical"
    LAST_PLAYED = "last_played"


class BggAuthState(StrEnum):
    """Surfaced on /bgg/sync/status so the FE knows which card to render."""

    UNLINKED = "unlinked"            # No bgg_username on profile
    LINKED = "linked"                # Username + encrypted password present
    RELINK_REQUIRED = "relink_required"  # Username only (legacy public link)


class PlayMode(StrEnum):
    """Scoring style for a game / play. Persisted on boardgamebuddy_games.play_mode."""

    COMPETITIVE = "competitive"  # Per-player scores; highest total wins (today's UI)
    COOP = "coop"                # All players win or all players lose together
    TEAM = "team"                # Players assigned to teams; the winning team takes it


# BGG mechanic value → PlayMode default. List (not dict) so iteration order is
# stable: the first match wins, so COOP is checked before TEAM — a game tagged
# both Cooperative and Team-Based should play as coop.
BGG_MECHANIC_TO_MODE: list[tuple[str, PlayMode]] = [
    ("Cooperative Game", PlayMode.COOP),
    ("Team-Based Game", PlayMode.TEAM),
]


def derive_play_mode(mechanics: list[str] | None) -> PlayMode:
    """Map a BGG mechanics array to its default PlayMode."""
    mset = set(mechanics or [])
    for tag, mode in BGG_MECHANIC_TO_MODE:
        if tag in mset:
            return mode
    return PlayMode.COMPETITIVE


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
