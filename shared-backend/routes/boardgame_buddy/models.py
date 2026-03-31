"""Pydantic models for BoardgameBuddy."""

from datetime import date, datetime
from typing import Optional
from pydantic import BaseModel

from .constants import CollectionStatus


# ── Shared ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    project: str
    status: str


class MessageResponse(BaseModel):
    message: str


# ── Profile ───────────────────────────────────────────────────────────────────

class ProfileCreate(BaseModel):
    display_name: str


class ProfileResponse(BaseModel):
    id: str
    display_name: str
    avatar_url: Optional[str] = None
    created_at: datetime


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
    bgg_rank: Optional[int] = None
    bgg_rating: Optional[float] = None
    theme_color: Optional[str] = None


class GameDetail(GameSummary):
    description: Optional[str] = None
    image_url: Optional[str] = None
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
    game: GameSummary


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


# ── Buddies ───────────────────────────────────────────────────────────────────

class BuddyResponse(BaseModel):
    id: str
    name: str
    linked_user_id: Optional[str] = None
    created_at: datetime


class BuddyLinkBody(BaseModel):
    user_id: str


# ── Guides ────────────────────────────────────────────────────────────────────

class GuideResponse(BaseModel):
    id: str
    game_id: str
    quick_setup: Optional[str] = None
    player_guide: Optional[str] = None
    rulebook_url: Optional[str] = None
    is_official: bool
    contributed_by: Optional[str] = None
    updated_at: datetime


class GuideCreate(BaseModel):
    quick_setup: Optional[str] = None
    player_guide: Optional[str] = None
    rulebook_url: Optional[str] = None
