"""Pydantic request/response models for the person (personal page) API."""

from typing import List, Optional

from pydantic import BaseModel


# ── Responses ────────────────────────────────────────────────────────────────
class TripSummaryResponse(BaseModel):
    """A trip as shown on the about-page card grid (no stops)."""
    id: str
    slug: str
    title: str
    eyebrow: Optional[str] = None
    headline: Optional[str] = None
    lede: Optional[str] = None
    photo_album_url: Optional[str] = None
    card_cta: Optional[str] = None
    sort_order: int
    is_published: bool


class StopSummaryResponse(BaseModel):
    """A stop's card metadata — never includes the heavy html_content."""
    id: str
    trip_id: str
    title: str
    meta: Optional[str] = None
    note: Optional[str] = None
    sort_order: int


class TripDetailResponse(TripSummaryResponse):
    """A trip plus its ordered stops (metadata only)."""
    stops: List[StopSummaryResponse] = []


class StopContentResponse(BaseModel):
    """A single stop's full HTML page — fetched once per popup open."""
    id: str
    title: str
    html_content: str


class MessageResponse(BaseModel):
    """Generic confirmation for delete/reorder operations."""
    status: str
    id: Optional[str] = None


# ── Request bodies ───────────────────────────────────────────────────────────
class CreateTripBody(BaseModel):
    title: str
    slug: Optional[str] = None  # auto-generated from title when omitted
    eyebrow: Optional[str] = None
    headline: Optional[str] = None
    lede: Optional[str] = None
    photo_album_url: Optional[str] = None
    card_cta: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None


class UpdateTripBody(BaseModel):
    title: Optional[str] = None
    slug: Optional[str] = None
    eyebrow: Optional[str] = None
    headline: Optional[str] = None
    lede: Optional[str] = None
    photo_album_url: Optional[str] = None
    card_cta: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None


class CreateStopBody(BaseModel):
    title: str
    html_content: str
    meta: Optional[str] = None
    note: Optional[str] = None
    sort_order: Optional[int] = None


class UpdateStopBody(BaseModel):
    title: Optional[str] = None
    meta: Optional[str] = None
    note: Optional[str] = None
    html_content: Optional[str] = None
    sort_order: Optional[int] = None


class ReorderStopsBody(BaseModel):
    stop_ids: List[str]
