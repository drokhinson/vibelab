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
    expansion_name: Optional[str] = None


class ChunkUpdate(BaseModel):
    chunk_type: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    layout: Optional[str] = None
    expansion_name: Optional[str] = None


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
    expansion_name: Optional[str] = None
    is_default: bool = False
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
    expansion_name: Optional[str] = None


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
    created_at: datetime


class PendingGuideDetail(PendingGuideSummary):
    bundle: dict[str, Any]


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


class ExpansionToggleRequest(BaseModel):
    is_enabled: bool


class ExpansionColorUpdate(BaseModel):
    color: str
