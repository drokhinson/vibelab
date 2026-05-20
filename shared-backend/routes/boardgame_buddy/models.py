"""Pydantic models for BoardgameBuddy."""

from datetime import date, datetime
from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, Field, SecretStr, computed_field

from .constants import (
    BggAuthState,
    BuddyEdgeStatus,
    CollectionStatus,
    FeedCardKind,
    PlayMode,
    PlaySessionStatus,
    SessionPhase,
)


# ── Shared ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    project: str
    status: str


class MessageResponse(BaseModel):
    message: str


class RefreshImagesResponse(BaseModel):
    updated: int


# ── Profile ───────────────────────────────────────────────────────────────────

class ProfileCreate(BaseModel):
    display_name: str


class ProfileResponse(BaseModel):
    id: str
    display_name: str
    # Stable handle (migration 017). Readonly in the FE; search matches it.
    username: str
    avatar_url: Optional[str] = None
    is_admin: bool = False
    created_at: datetime


class AdminKeyBody(BaseModel):
    admin_key: str


# ── BGG account linking ───────────────────────────────────────────────────────

class BggLinkBody(BaseModel):
    """Credentials for POST /bgg/link.

    BGG requires the *web* login flow (username + password) to mint a SessionID
    cookie; we exchange the password at link time, store it Fernet-encrypted,
    and use the resulting cookies on subsequent xmlapi2 calls.
    """
    username: str = Field(..., min_length=1, max_length=64)
    password: SecretStr = Field(..., min_length=1, max_length=256)


class BggLinkResponse(BaseModel):
    bgg_username: Optional[str] = None


class BggSyncSummary(BaseModel):
    """Result of POST /bgg/sync.

    Counts that landed in their respective tables synchronously plus the
    pending counts that the background worker will drain after importing
    the missing games from BGG.
    """
    bgg_username: str
    collection_imported: int
    collection_pending: int
    plays_imported: int
    plays_pending: int
    # True when BGG kept returning "still preparing" for every batch and the
    # sync ended up with nothing to import. The FE shows a "try again shortly"
    # toast instead of "Imported 0".
    warm_up_retry_pending: bool = False


class BggSyncStatus(BaseModel):
    """Result of GET /bgg/sync/status. Used by the FE to poll progress."""
    bgg_username: Optional[str] = None
    auth_state: BggAuthState = BggAuthState.UNLINKED
    pending_count: int = 0
    errored_count: int = 0
    last_completed_at: Optional[datetime] = None


# ── Games ─────────────────────────────────────────────────────────────────────

class GameSummary(BaseModel):
    id: str
    bgg_id: Optional[int] = None
    name: str
    year_published: Optional[int] = None
    min_players: Optional[int] = None
    max_players: Optional[int] = None
    playing_time: Optional[int] = None
    thumbnail_url: Optional[str] = None
    image_url: Optional[str] = None
    theme_color: Optional[str] = None
    is_expansion: bool = False
    base_game_bgg_id: Optional[int] = None
    expansion_color: Optional[str] = None
    rulebook_url: Optional[str] = None
    play_mode: PlayMode = PlayMode.COMPETITIVE
    # Number of expansion rows in boardgamebuddy_games that point at this
    # game (via base_game_bgg_id == this.bgg_id). Populated by the list
    # endpoints so browse/search tiles can show a "git-fork N" badge.
    # Defaults to 0 for callers that don't bother computing it.
    expansion_count: int = 0

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> Optional[str]:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}" if self.bgg_id else None


class GameDetail(GameSummary):
    description: Optional[str] = None
    categories: list[str] = []
    mechanics: list[str] = []
    created_at: datetime
    # Populated on expansion rows so the FE can render a "Back to <base>" link
    # without a second lookup. Resolved via base_game_bgg_id at read time.
    base_game_id: Optional[str] = None
    base_game_name: Optional[str] = None


class GameListResponse(BaseModel):
    games: list[GameSummary]
    total: int
    page: int
    per_page: int


class BggSearchResult(BaseModel):
    bgg_id: int
    name: str
    year_published: Optional[int] = None
    is_expansion: bool = False
    already_in_db: bool = False

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> str:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}"


# ── Collection ────────────────────────────────────────────────────────────────

class CollectionAdd(BaseModel):
    game_id: str
    status: CollectionStatus


class CollectionUpdate(BaseModel):
    status: CollectionStatus


class CollectionItem(BaseModel):
    id: str
    game_id: str
    status: str
    added_at: datetime
    last_played_at: Optional[date] = None
    play_count: int = 0
    game: GameSummary
    # When this row is a base game and the user owns/has-wishlisted/has-played
    # one or more of its expansions on the same shelf, those expansion rows
    # ride along here so the FE can show them nested without a follow-up call.
    expansions: list["CollectionItem"] = Field(default_factory=list)


CollectionItem.model_rebuild()


class CollectionPageResponse(BaseModel):
    items: list[CollectionItem]
    total: int
    page: int
    per_page: int


# ── Plays ─────────────────────────────────────────────────────────────────────

class PlayerEntry(BaseModel):
    name: str
    is_winner: bool = False
    score: Optional[int] = None
    # Real-account player id. Populated when the FE picks this player from
    # the user's accepted-buddy list; None for free-text ghost players.
    # Backend uses it to populate play_players.player_user_id (migration 009)
    # so the new feed RPC can resolve the winner's display name.
    user_id: Optional[str] = None


class PlayExpansionRef(BaseModel):
    expansion_game_id: str
    name: str
    color: Optional[str] = None


class PlayCreate(BaseModel):
    game_id: str
    played_at: date
    players: list[PlayerEntry] = []
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    expansion_ids: list[str] = []
    # Optional per-play scoring style override (migration 007). When None,
    # the play inherits the game's stored play_mode at insert time.
    play_mode: Optional[PlayMode] = None


class PlayUpdate(BaseModel):
    # Full replacement of the play. Mirrors PlayCreate but game_id can't change
    # — pivoting a play to a different game would orphan the per-player scores.
    played_at: date
    players: list[PlayerEntry] = []
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    expansion_ids: list[str] = []
    play_mode: Optional[PlayMode] = None


class PlayPhotoResponse(BaseModel):
    photo_url: str


class PlayPlayerResponse(BaseModel):
    # buddy_id is the legacy per-owner buddy row. Optional now: after
    # migration 013 the column is gone and writes through the new path
    # populate player_user_id/player_display_name directly.
    buddy_id: Optional[str] = None
    user_id: Optional[str] = None
    name: str
    is_winner: bool
    score: Optional[int] = None


class PlayResponse(BaseModel):
    id: str
    game_id: str
    game_name: str
    game_thumbnail: Optional[str] = None
    played_at: date
    notes: Optional[str] = None
    players: list[PlayPlayerResponse] = []
    photo_url: Optional[str] = None
    expansions: list[PlayExpansionRef] = []
    created_at: datetime
    # Resolved scoring style for this play. Set from PlayCreate.play_mode if
    # provided, else inherited from the game at insert time. Always populated.
    play_mode: PlayMode = PlayMode.COMPETITIVE
    # Logger metadata — lets the FE distinguish own logs from shared plays
    # (where the current user appears via a linked buddy).
    logged_by_id: str
    logged_by_name: str
    is_own: bool = True


class PlayCountResponse(BaseModel):
    count: int


class PlayListResponse(BaseModel):
    plays: list[PlayResponse]
    total: int
    page: int
    per_page: int


class PlayFilterOption(BaseModel):
    id: str
    name: str


class PlayFilterOptions(BaseModel):
    games: list[PlayFilterOption]
    buddies: list[PlayFilterOption]


# ── Buddies ───────────────────────────────────────────────────────────────────

class BuddyResponse(BaseModel):
    id: str
    name: str  # original free-text name (preserved even after linking)
    linked_user_id: Optional[str] = None
    linked_display_name: Optional[str] = None  # joined from boardgamebuddy_profiles
    play_count: int = 0
    created_at: datetime


class BuddyLinkBody(BaseModel):
    user_id: str


class ProfileSearchResult(BaseModel):
    id: str
    display_name: str
    username: str
    email: Optional[str] = None


# ── Reference-guide chapters ──────────────────────────────────────────────────

class ChapterTypeResponse(BaseModel):
    id: str
    label: str
    icon: Optional[str] = None
    display_order: int


class ChapterCreate(BaseModel):
    chapter_type: str
    title: str
    content: str
    layout: str = "text"


class ChapterUpdate(BaseModel):
    chapter_type: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    layout: Optional[str] = None


class ChapterResponse(BaseModel):
    id: str
    game_id: str
    chapter_type: str
    chapter_type_label: Optional[str] = None
    chapter_type_icon: Optional[str] = None
    chapter_type_order: int = 0
    title: str
    layout: str
    content: str
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    updated_at: datetime
    # Source-game tagging — populated whenever the response might mix chapters
    # from multiple games (base + expansions). Always equals (game_id, game
    # name, expansion_color) for the chapter's defining game; source_color is
    # None for base games and the boardgamebuddy_games.expansion_color for
    # expansion rows.
    source_game_id: Optional[str] = None
    source_game_name: Optional[str] = None
    source_color: Optional[str] = None


class ChapterPoolItem(ChapterResponse):
    # Number of users who have this chapter in their guide. Browse pool
    # rows are sorted by `popularity DESC, created_at DESC`.
    popularity: int = 0
    # Whether the calling user already has this chapter in their guide.
    # Frontend hides rows where this is true. Anon callers always see
    # `in_my_guide=false`.
    in_my_guide: bool = False


class MyGuideChapterResponse(ChapterResponse):
    added_at: datetime


class AddChapterRequest(BaseModel):
    chapter_id: str


class ChapterReportCreate(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)


class ChapterReportResponse(BaseModel):
    id: str
    chapter_id: str
    chapter_title: str
    chapter_content_preview: str
    chapter_type: str
    chapter_type_label: Optional[str] = None
    game_id: str
    game_name: str
    reporter_id: str
    reporter_name: Optional[str] = None
    reason: Optional[str] = None
    status: str
    created_at: datetime
    resolved_at: Optional[datetime] = None


# ── Expansions ────────────────────────────────────────────────────────────────

class ExpansionListItem(BaseModel):
    expansion_game_id: str
    bgg_id: Optional[int] = None
    name: str
    thumbnail_url: Optional[str] = None
    color: Optional[str] = None
    is_enabled: bool = False
    rulebook_url: Optional[str] = None


class ExpansionToggleRequest(BaseModel):
    is_enabled: bool


class ExpansionColorUpdate(BaseModel):
    color: str


class RulebookUrlUpdate(BaseModel):
    """Admin override to set or clear a game's rulebook_url. Pass null to clear."""

    rulebook_url: Optional[str] = None


# ── Mutual buddy graph (migration 008) ────────────────────────────────────────

class BuddyEdgeResponse(BaseModel):
    """An accepted buddy edge from the current user's perspective."""

    id: str
    other_user_id: str
    other_display_name: str
    other_avatar_url: Optional[str] = None
    accepted_at: Optional[datetime] = None
    created_at: datetime


class BuddyRequestResponse(BaseModel):
    """A pending buddy request, either incoming or outgoing."""

    id: str
    direction: Literal["incoming", "outgoing"]
    other_user_id: str
    other_display_name: str
    other_avatar_url: Optional[str] = None
    created_at: datetime


class BuddyRequestsResponse(BaseModel):
    incoming: list[BuddyRequestResponse] = []
    outgoing: list[BuddyRequestResponse] = []


class BuddyRequestCreate(BaseModel):
    target_user_id: str


# ── Played-with discovery (real accounts + ghost players) ─────────────────────

class PlayedWithUser(BaseModel):
    """A real-account player who appears in plays the viewer is part of."""

    user_id: str
    display_name: str
    avatar_url: Optional[str] = None
    play_count: int
    is_buddy: bool = False
    has_pending_request: bool = False
    pending_request_direction: Optional[Literal["incoming", "outgoing"]] = None


class GhostPlayer(BaseModel):
    """A free-text nickname the viewer recorded in plays without an account."""

    display_name: str
    play_count: int
    last_played_at: Optional[date] = None


class GhostLinkRequest(BaseModel):
    """Promote a ghost nickname to a real account across the viewer's plays."""

    display_name: str
    target_user_id: str


class GhostLinkResponse(BaseModel):
    rows_updated: int


# ── Public profile view (Strava-style) ────────────────────────────────────────

class PublicProfileResponse(BaseModel):
    """Always 200 — profiles are fully public per product decision."""

    id: str
    display_name: str
    username: str
    avatar_url: Optional[str] = None
    created_at: datetime
    # Whether the viewer has an accepted mutual edge with this profile. The FE
    # uses this to swap the "Add buddy" button for an "Unfriend" affordance.
    is_buddy: bool = False
    # Whether a pending request exists in either direction. FE shows
    # "Request sent" / "Accept request" instead of "Add buddy".
    has_pending_request: bool = False
    pending_request_direction: Optional[Literal["incoming", "outgoing"]] = None


class FavoriteGame(BaseModel):
    """The game the viewer has played the most. None when no plays exist."""

    game_id: str
    name: str
    play_count: int


class StatsResponse(BaseModel):
    total_plays: int = 0
    unique_games: int = 0
    win_count: int = 0
    last_played_at: Optional[date] = None
    hours_played: float = 0.0
    # owned_games excludes expansions — the count the user thinks of as
    # "my games". owned_expansions is the secondary counter for box clutter.
    owned_games: int = 0
    owned_expansions: int = 0
    favorite_game: Optional[FavoriteGame] = None


# ── Play sessions (short-code lobby) ──────────────────────────────────────────

class SessionParticipantResponse(BaseModel):
    id: str
    user_id: Optional[str] = None
    display_name: str
    joined_at: datetime
    avatar_url: Optional[str] = None


class SessionResponse(BaseModel):
    id: str
    code: str
    status: PlaySessionStatus
    # Host-driven cursor through the Gather → Play → Settle Up flow
    # (migration 026). Defaults to gather for legacy rows that pre-date
    # the column.
    phase: SessionPhase = SessionPhase.GATHER
    host_user_id: str
    game_id: Optional[str] = None
    game: Optional[GameSummary] = None
    participants: list[SessionParticipantResponse] = []
    created_at: datetime
    expires_at: datetime
    finalized_play_id: Optional[str] = None


class SessionCreate(BaseModel):
    game_id: Optional[str] = None


class SessionUpdateBody(BaseModel):
    # Currently the only field a host may change on an open lobby. Sent as
    # null when clearing the pick, set to a game UUID when (re)selecting one.
    game_id: Optional[str] = None


class SessionPhaseUpdate(BaseModel):
    phase: SessionPhase


class SessionJoinBody(BaseModel):
    # Used only when the caller is not authenticated (guest join). When a real
    # user joins, the display_name is taken from their profile and this field
    # is ignored.
    display_name: Optional[str] = None


class JoinableSession(BaseModel):
    """A session the calling user can join from the Join chooser screen.

    Surfaces sessions that are still in the gather phase where the viewer
    is either (a) the host of the session — useful for refresh recovery,
    (b) already listed as a participant — rejoin after a disconnect, or
    (c) the host is one of the viewer's accepted buddies.
    """

    id: str
    code: str
    host_user_id: str
    host_display_name: str
    host_avatar_url: Optional[str] = None
    game: Optional[GameSummary] = None
    participant_count: int = 0
    is_participant: bool = False
    is_host_buddy: bool = False
    created_at: datetime


class JoinableSessionsResponse(BaseModel):
    sessions: list[JoinableSession] = []


# ── Unified search ────────────────────────────────────────────────────────────

class UnifiedSearchHit(BaseModel):
    """A single hit in the unified ranked search list."""

    source: Literal["collection", "db"]
    game: GameSummary
    # Present when source='collection': which shelf this game sits on for the
    # viewer ('owned' | 'wishlist'). None otherwise.
    collection_status: Optional[str] = None


class UnifiedSearchResponse(BaseModel):
    results: list[UnifiedSearchHit] = []
    # Always present; only populated when include_bgg=true was passed.
    bgg_results: list[BggSearchResult] = []
    # True when the caller passed include_bgg=true (regardless of whether BGG
    # actually returned anything). Lets the FE tell "BGG fetched but empty"
    # apart from "BGG not requested".
    bgg_searched: bool = False


# ── Feed cards ────────────────────────────────────────────────────────────────

class FeedPlayUser(BaseModel):
    id: str
    display_name: str
    avatar_url: Optional[str] = None


class FeedPlayParticipant(BaseModel):
    user_id: str
    display_name: str


class FeedPlayCard(BaseModel):
    kind: Literal[FeedCardKind.PLAY] = FeedCardKind.PLAY
    play_id: str
    user: FeedPlayUser
    game: GameSummary
    played_at: date
    created_at: datetime
    notes: Optional[str] = None
    photo_url: Optional[str] = None
    play_mode: PlayMode = PlayMode.COMPETITIVE
    winner_display_name: Optional[str] = None
    participant_count: int = 0
    # Paired {user_id, display_name} list filtered to the viewer + their
    # accepted buddies (ghosts and non-buddy registered players excluded).
    # Drives the session grouping key on the FE and the clickable names in
    # the session header. Sorted by display_name in the RPC.
    participants: list[FeedPlayParticipant] = []


class FeedHotGamesEntry(BaseModel):
    game: GameSummary
    play_count: int


class FeedHotGamesCard(BaseModel):
    kind: Literal[FeedCardKind.HOT_GAMES] = FeedCardKind.HOT_GAMES
    window_days: int
    games: list[FeedHotGamesEntry]


class FeedSuggestedBuddy(BaseModel):
    user_id: str
    display_name: str
    avatar_url: Optional[str] = None
    mutual_count: int


class FeedSuggestedBuddiesCard(BaseModel):
    kind: Literal[FeedCardKind.SUGGESTED_BUDDIES] = FeedCardKind.SUGGESTED_BUDDIES
    suggestions: list[FeedSuggestedBuddy]


class FeedFeaturedFromCollectionEntry(BaseModel):
    game: GameSummary
    last_played_at: Optional[date] = None


class FeedFeaturedFromCollectionCard(BaseModel):
    kind: Literal[FeedCardKind.FEATURED_FROM_COLLECTION] = FeedCardKind.FEATURED_FROM_COLLECTION
    games: list[FeedFeaturedFromCollectionEntry]


FeedCard = Union[
    FeedPlayCard,
    FeedHotGamesCard,
    FeedSuggestedBuddiesCard,
    FeedFeaturedFromCollectionCard,
]


class FeedPageResponse(BaseModel):
    cards: list[FeedCard]
    # Composite "played_at|created_at" of the last play on this page; null =
    # no more pages. The FE round-trips this string back as ?cursor=… on the
    # next call (no parsing required).
    next_cursor: Optional[str] = None


class HotGamesResponse(BaseModel):
    games: list[FeedHotGamesEntry] = []
    window_days: int


class SuggestedBuddiesResponse(BaseModel):
    suggestions: list[FeedSuggestedBuddy] = []


class FeaturedFromCollectionResponse(BaseModel):
    games: list[FeedFeaturedFromCollectionEntry] = []
