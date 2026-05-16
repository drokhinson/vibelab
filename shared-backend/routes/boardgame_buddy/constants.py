"""Constants and enums for BoardgameBuddy."""

from enum import StrEnum


class CollectionStatus(StrEnum):
    OWNED = "owned"
    # Legacy synthetic shelf — derived from boardgamebuddy_plays, never written
    # to boardgamebuddy_collections after migration 010. Kept on the enum so
    # existing /collection endpoints can still serve the "Played" filter while
    # the new Feed/Profile views replace them.
    PLAYED = "played"
    WISHLIST = "wishlist"


class BuddyEdgeStatus(StrEnum):
    """Lifecycle of a mutual buddy edge (boardgamebuddy_buddy_edges)."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    BLOCKED = "blocked"


class PlaySessionStatus(StrEnum):
    """Lifecycle of a short-code play-logging session."""

    OPEN = "open"
    FINALIZED = "finalized"
    ABANDONED = "abandoned"


class FeedCardKind(StrEnum):
    """Card types the Feed view can render."""

    PLAY = "play"
    HOT_GAMES = "hot_games"
    SUGGESTED_BUDDIES = "suggested_buddies"
    FEATURED_FROM_COLLECTION = "featured_from_collection"


# Short-code session codes use Crockford base32 (no I, L, O, U to avoid OCR /
# voice ambiguity). 5 chars → 32^5 ≈ 33M codes; service layer retries on
# collision so absolute uniqueness only matters within currently-open sessions.
PLAY_SESSION_CODE_ALPHABET: str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PLAY_SESSION_CODE_LENGTH: int = 5


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


# BGG mechanic value → PlayMode default. Each entry is checked against the
# game's mechanics array; the first match wins, so COOP entries come before
# TEAM (a game tagged both Cooperative and Team-Based should play as coop).
# BGG's XML returns the mechanic as just "Cooperative" / "Team-Based" in
# practice; the " Game" forms are kept as a defensive fallback in case a
# historical sync path used the longer wording.
BGG_MECHANIC_TO_MODE: list[tuple[str, PlayMode]] = [
    ("Cooperative", PlayMode.COOP),
    ("Cooperative Game", PlayMode.COOP),
    ("Team-Based", PlayMode.TEAM),
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
