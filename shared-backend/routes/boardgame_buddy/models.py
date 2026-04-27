"""Pydantic models for BoardgameBuddy."""

from datetime import date, datetime
from typing import Any, Optional
from pydantic import BaseModel, Field, computed_field

from .constants import CollectionStatus


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
    avatar_url: Optional[str] = None
    is_admin: bool = False
    created_at: datetime


class AdminKeyBody(BaseModel):
    admin_key: str


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

    @computed_field  # type: ignore[misc]
    @property
    def bgg_url(self) -> Optional[str]:
        return f"https://boardgamegeek.com/boardgame/{self.bgg_id}" if self.bgg_id else None


class GameDetail(GameSummary):
    description: Optional[str] = None
    categories: list[str] = []
    mechanics: list[str] = []
    created_at: datetime


class GameListResponse(BaseModel):
    games: list[GameSummary]
    total: int
    page: int
    per_page: int


class BggSearchResult(BaseModel):
    bgg_id: int
    name: str
    year_published: Optional[int] = None
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


class CollectionPageResponse(BaseModel):
    items: list[CollectionItem]
    total: int
    page: int
    per_page: int


# ── Plays ─────────────────────────────────────────────────────────────────────

class PlayerEntry(BaseModel):
    name: str
    is_winner: bool = False


class PlayCreate(BaseModel):
    game_id: str
    played_at: date
    players: list[PlayerEntry] = []
    notes: Optional[str] = None


class PlayPlayerResponse(BaseModel):
    buddy_id: str
    name: str
    is_winner: bool


class PlayResponse(BaseModel):
    id: str
    game_id: str
    game_name: str
    game_thumbnail: Optional[str] = None
    played_at: date
    notes: Optional[str] = None
    players: list[PlayPlayerResponse] = []
    created_at: datetime
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


# ── Play session draft (in-progress, unsaved) ─────────────────────────────────

class PlayDraftPlayer(BaseModel):
    name: str
    is_winner_override: Optional[bool] = None
    round_scores: list[float] = []
    initials: Optional[str] = None


class PlayDraftBody(BaseModel):
    game_id: Optional[str] = None
    played_at: Optional[date] = None
    notes: Optional[str] = None
    players: list[PlayDraftPlayer] = []
    round_count: int = 1


class PlayDraftResponse(PlayDraftBody):
    game_name: Optional[str] = None
    game_thumbnail: Optional[str] = None
    updated_at: datetime


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
    # approved=false rows are visible only to the creator until an admin
    # approves them; pending_guide_id links to the review-queue submission.
    approved: bool = True
    pending_guide_id: Optional[str] = None
    created_by: Optional[str] = None
    created_by_name: Optional[str] = None
    updated_at: datetime
    expansion: Optional[ExpansionInline] = None


class MyGuideChunkResponse(ChunkResponse):
    is_hidden: bool = False
    user_display_order: Optional[int] = None


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


class GuideBundleChunk(BaseModel):
    chunk_type: str
    title: str = Field(..., max_length=200)
    content: str
    layout: str = "text"


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
    # True when the bundle's bgg_id has no matching boardgamebuddy_games row —
    # i.e. approving will create the game. False when chunks are being added
    # to a game that's already in the library.
    is_new_game: bool = True
    created_at: datetime


class PendingGuideDetail(PendingGuideSummary):
    bundle: dict[str, Any]
    # Live chunk rows linked to this submission (approved=false rows).
    # The frontend renders the modal off these rather than the cached JSONB
    # so per-chunk default toggles + edits work against real DB rows.
    chunks: list[ChunkResponse] = []


class PendingGuideDecisionBody(BaseModel):
    notes: Optional[str] = None
    force: bool = False
    override_bundle: Optional[GuideBundle] = None
    # UUIDs of chunks the admin wants promoted to is_default=true on approve.
    # Frontend's "Select all as default" passes every chunk's id; default state
    # is empty (chunks land as community contributions unless promoted).
    default_chunk_ids: list[str] = []


# ── BGG metadata preview (used by import + review UIs) ───────────────────────

class BggGameMetaResponse(BaseModel):
    bgg_id: int
    name: str
    year_published: Optional[int] = None
    min_players: Optional[int] = None
    max_players: Optional[int] = None
    playing_time: Optional[int] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    categories: list[str] = []
    mechanics: list[str] = []
    is_expansion: bool = False
    base_game_bgg_id: Optional[int] = None
    # When true, the game is already in our library (DB row served instead of
    # a fresh BGG fetch); db_game_id points to the existing UUID. Lets the FE
    # skip the BGG roundtrip and render an "Adding to existing game" header.
    already_in_db: bool = False
    db_game_id: Optional[str] = None


# ── Expansions ────────────────────────────────────────────────────────────────

class ExpansionListItem(BaseModel):
    expansion_game_id: str
    bgg_id: Optional[int] = None
    name: str
    thumbnail_url: Optional[str] = None
    color: Optional[str] = None
    is_enabled: bool = False
    chunk_count: int = 0


class ExpansionToggleRequest(BaseModel):
    is_enabled: bool


class ExpansionColorUpdate(BaseModel):
    color: str
