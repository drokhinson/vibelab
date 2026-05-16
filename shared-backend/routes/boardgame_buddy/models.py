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


# ── Guide chunks ──────────────────────────────────────────────────────────────

class ChunkTypeResponse(BaseModel):
    id: str
    label: str
    icon: Optional[str] = None
    display_order: int


class ChunkCreate(BaseModel):
    chunk_type: str
    title: str
    content: str
    layout: str = "text"


class ChunkUpdate(BaseModel):
    chunk_type: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    layout: Optional[str] = None
    # Admin-only. Promotes/demotes a chunk in the curated default guide.
    is_default: Optional[bool] = None


class ExpansionInline(BaseModel):
    """Source-pack metadata inlined on chunks that come from an expansion.

    `expansion_game_id` is the game UUID (FK target). The frontend uses
    `color` to render the dot in the chunk header; `name` powers the tooltip.
    """
    expansion_game_id: str
    name: str
    color: Optional[str] = None


class ChunkResponse(BaseModel):
    id: str
    game_id: str
    chunk_type: str
    chunk_type_label: Optional[str] = None
    chunk_type_icon: Optional[str] = None
    chunk_type_order: int = 0
    title: str
    layout: str
    content: str
    is_default: bool = False
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    updated_at: datetime
    expansion: Optional[ExpansionInline] = None


class MyGuideChunkResponse(ChunkResponse):
    is_hidden: bool = False
    user_display_order: Optional[int] = None
    # True for base-game chunks and chunks from expansions the user has
    # enabled. False only when include_all_expansions=true surfaces a chunk
    # from a linked-but-disabled expansion so the frontend can cache it.
    is_expansion_enabled: bool = True


class MyGuideResponse(BaseModel):
    has_customizations: bool
    chunks: list[MyGuideChunkResponse]


class GuideSelectionUpdate(BaseModel):
    chunk_ids: list[str]


class ChunkVisibilityUpdate(BaseModel):
    is_hidden: bool


# ── Guide bundle import (agentic generator) ───────────────────────────────────

class GuideBundleGame(BaseModel):
    bgg_id: int = Field(..., gt=0)
    name: str
    min_players: Optional[int] = None
    max_players: Optional[int] = None
    playing_time: Optional[int] = None
    bgg_url: Optional[str] = None
    is_expansion: bool = False
    base_game_bgg_id: Optional[int] = None
    rulebook_url: Optional[str] = None


class GuideBundleChunk(BaseModel):
    chunk_type: str
    title: str = Field(..., max_length=200)
    content: str
    layout: str = "text"
    # Per-chunk override. None falls back to the bulk default determined by the
    # caller (admin direct import → True; community submission → False).
    is_default: Optional[bool] = None


class GuideBundle(BaseModel):
    version: int = 1
    game: GuideBundleGame
    chunks: list[GuideBundleChunk] = Field(..., min_length=1, max_length=25)
    source: Optional[dict[str, Any]] = None


class GuideImportResponse(BaseModel):
    game_id: str
    imported_game: bool
    chunks_inserted: int
    chunks_skipped: int
    skipped_reasons: list[str]
    # Set when a new game was inserted directly from bundle metadata and the
    # follow-up best-effort BGG image fetch failed. Approval still succeeds.
    image_fetch_warning: Optional[str] = None


# ── Pending guide review (user-uploaded bundles) ──────────────────────────────

class PendingGuideSubmitResponse(BaseModel):
    id: Optional[str] = None
    status: str  # "submitted" — always queued for admin review
    message: str
    import_result: Optional[GuideImportResponse] = None


class PendingGuideSummary(BaseModel):
    id: str
    uploader_id: str
    uploader_name: Optional[str] = None
    game_name: str
    bgg_id: Optional[int] = None
    chunk_count: int
    status: str
    created_at: datetime


class PendingGuideDetail(PendingGuideSummary):
    bundle: dict[str, Any]
    # Existing-game lookup so the review UI can show NEW vs EXISTING up front.
    game_exists: bool = False
    existing_game: Optional[GameSummary] = None


class PendingGuideDecisionBody(BaseModel):
    notes: Optional[str] = None
    force: bool = False
    override_bundle: Optional[GuideBundle] = None


# ── Expansions ────────────────────────────────────────────────────────────────

class ExpansionListItem(BaseModel):
    expansion_game_id: str
    bgg_id: Optional[int] = None
    name: str
    thumbnail_url: Optional[str] = None
    color: Optional[str] = None
    is_enabled: bool = False
    chunk_count: int = 0
    rulebook_url: Optional[str] = None


class ExpansionToggleRequest(BaseModel):
    is_enabled: bool


class ExpansionColorUpdate(BaseModel):
    color: str


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
    host_user_id: str
    game_id: Optional[str] = None
    game: Optional[GameSummary] = None
    participants: list[SessionParticipantResponse] = []
    created_at: datetime
    expires_at: datetime
    finalized_play_id: Optional[str] = None


class SessionCreate(BaseModel):
    game_id: Optional[str] = None


class SessionJoinBody(BaseModel):
    # Used only when the caller is not authenticated (guest join). When a real
    # user joins, the display_name is taken from their profile and this field
    # is ignored.
    display_name: Optional[str] = None


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
