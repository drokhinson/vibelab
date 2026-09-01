"""Constants and enums for BoardgameBuddy."""

import os
from enum import StrEnum


# ── Add-a-buddy QR tokens ────────────────────────────────────────────────────
# Signs the short-lived tokens the add-a-buddy QR code encodes (see
# services/buddy_qr_service.py). A dedicated secret rather than a reused app
# one: it is the only thing giving these tokens domain separation, so a token
# minted here can never validate against another endpoint and no other app's
# token validates here. Rotating this value is also the revocation lever — it
# invalidates every outstanding code at once, which is why the tokens
# themselves carry no server-side state.
BGB_QR_SECRET = os.environ.get("BGB_QR_SECRET", "dev-secret-change-me")
QR_TOKEN_ALGORITHM = "HS256"
# Three minutes. Long enough for three people around a table to each get their
# phone out; short enough that a screenshot or a shoulder-surfed photo is worth
# nothing by the time anyone acts on it. The frontend re-mints at 150s so a
# sheet left open never shows a dead code.
QR_TOKEN_TTL_SECONDS = 180


class CollectionStatus(StrEnum):
    OWNED = "owned"
    # Legacy synthetic shelf — derived from boardgamebuddy_plays, never written
    # to boardgamebuddy_collections after migration 010. Kept on the enum so
    # existing /collection endpoints can still serve the "Played" filter while
    # the new Feed/Profile views replace them.
    PLAYED = "played"
    WISHLIST = "wishlist"
    # A game the user sold, gifted or donated (migration 069). Persisted, and
    # deliberately asymmetric: it is a SUBSET OF OWNED for display — the Owned
    # shelf lists it alongside owned games, dimmed and stamped — and NOT OWNED
    # for counting, so every owned total (the Owned tab count, the profile
    # "Owned Games" stat, owned-expansion counts, the Shelf of Shame) skips it.
    # Distinct from deleting the row, which means "this was never mine".
    PREV_OWNED = "prev_owned"


# The statuses a request for the "owned" shelf actually matches. Only the
# surfaces that BUILD the Owned grid use this; every plain `status = 'owned'`
# filter elsewhere is correct as it stands, because prev_owned must not be
# counted as owned. See constants above and migration 069.
OWNED_SHELF_STATUSES: tuple[str, ...] = (
    CollectionStatus.OWNED.value,
    CollectionStatus.PREV_OWNED.value,
)


class BuddyEdgeStatus(StrEnum):
    """Lifecycle of a mutual buddy edge (boardgamebuddy_buddy_edges)."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    BLOCKED = "blocked"


class GhostClaimStatus(StrEnum):
    """Lifecycle of a ghost account claim (boardgamebuddy_ghost_claims, 070).

    Unlike BuddyEdgeStatus this never deletes: the (owner, ghost_name_key,
    claimant) triple is unique, so status mutates in place and reject_count
    survives a re-ask. That is what makes the two-strike rule stick.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    # The claimant's "Not me" — suppresses the suggestion without telling the
    # owner anything. Reversible: a later claim flips the same row to pending.
    DISMISSED = "dismissed"
    # Another claimant's accept took the ghost. The rows this claim points at
    # no longer exist, so it can never succeed.
    SUPERSEDED = "superseded"


class BuddySuggestionSource(StrEnum):
    """Why a buddy suggestion is in the list (migration 063).

    The onboarding "Add buddies" step ranks two tiers of candidate, and the
    tile's reason line can't be derived from the counts alone: an ACTIVE
    candidate carries mutual_count = 0 and play_count = 0, which the shared
    rail would otherwise label "Mutual buddy". The tier is the label."""

    # An earned signal — a shared play or a shared accepted buddy. The same
    # candidates bgb_suggested_buddies returns for the Feed rail.
    GRAPH = "graph"
    # Community fallback: people logging plays lately. Only the onboarding
    # step uses this tier, because a brand-new account has no earned signal
    # to rank on and an empty discovery screen is the failure case there.
    ACTIVE = "active"
    # A candidate promoted client-side out of the preloaded second hop
    # (migration 072): a buddy of someone the user has just ticked. Never
    # returned in the top-level `suggestions` list — the server sets it on the
    # rows inside `network`, and the deck renders them when that tick happens.
    NETWORK = "network"


# How many of each suggestion's buddies to preload, and the ceiling on the
# whole second hop. 12 suggestions × 6 is 72 rows before the total bites, and
# the endpoint ships a profile for every one it returns — so the pair is the
# payload budget for the onboarding step, not a ranking knob.
ONBOARDING_NETWORK_PER_SEED = 6
ONBOARDING_NETWORK_LIMIT = 48


class PlaySessionStatus(StrEnum):
    """Lifecycle of a short-code play-logging session."""

    OPEN = "open"
    FINALIZED = "finalized"
    ABANDONED = "abandoned"


class SessionPhase(StrEnum):
    """Host-driven cursor through the Gather → Play → Settle Up flow
    (migration 026). Joiners watch this via Supabase Realtime and auto-
    advance their read-only mirror when the host moves forward."""

    GATHER = "gather"
    PLAY = "play"
    SETTLE = "settle"
    FINALIZED = "finalized"
    ABANDONED = "abandoned"


# Allowed phase transitions. Forward moves drive the host through the
# guided flow; one-step backward moves let the host bounce back to a
# previous step (Play → Gather, Settle → Play) when they tap the
# top-left back arrow. Terminal states (finalized / abandoned) are
# absorbing — no resurrections.
ALLOWED_PHASE_TRANSITIONS: dict[SessionPhase, frozenset[SessionPhase]] = {
    SessionPhase.GATHER: frozenset({SessionPhase.PLAY, SessionPhase.ABANDONED}),
    SessionPhase.PLAY: frozenset(
        {SessionPhase.GATHER, SessionPhase.SETTLE, SessionPhase.ABANDONED}
    ),
    SessionPhase.SETTLE: frozenset(
        {SessionPhase.PLAY, SessionPhase.FINALIZED, SessionPhase.ABANDONED}
    ),
    SessionPhase.FINALIZED: frozenset(),
    SessionPhase.ABANDONED: frozenset(),
}


class FeedCardKind(StrEnum):
    """Card types the Feed view can render."""

    PLAY = "play"
    HOT_GAMES = "hot_games"
    SUGGESTED_BUDDIES = "suggested_buddies"




class CollectionSort(StrEnum):
    ALPHABETICAL = "alphabetical"
    LAST_PLAYED = "last_played"
    ADDED_AT = "added_at"


class CatalogSort(StrEnum):
    """Row order for GET /games.

    NEWEST is the historical default and stays the default: the Game Explorer
    and every other paginated catalog caller was built against created_at DESC.
    ALPHABETICAL is what a browse-the-whole-library screen wants — the Add
    Games page scrolls the entire catalog, where import order is noise.
    """

    NEWEST = "newest"
    ALPHABETICAL = "alphabetical"


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
