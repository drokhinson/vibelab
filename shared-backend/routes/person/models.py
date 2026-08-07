"""Pydantic request/response models for the person (personal page) API."""

from typing import List, Optional

from pydantic import BaseModel

from .constants import TripStatus, TripTheme


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
    icon_url: Optional[str] = None
    card_cta: Optional[str] = None
    sort_order: int
    is_published: bool
    status: TripStatus
    theme: TripTheme


class StopResponse(BaseModel):
    """A stop, including its full html_content.

    The trip-detail endpoint returns every stop in this shape so the trip page
    loads all stop HTML in a single pass and can open popups from memory.
    """
    id: str
    trip_id: str
    title: str
    meta: Optional[str] = None
    note: Optional[str] = None
    sort_order: int
    html_content: str


class TripDetailResponse(TripSummaryResponse):
    """A trip plus its ordered stops (each with full html_content)."""
    stops: List[StopResponse] = []


class StopContentResponse(BaseModel):
    """A single stop's full HTML page (direct fetch by id)."""
    id: str
    title: str
    html_content: str


class ProfileResponse(BaseModel):
    """The single profile block shown at the top of the about page."""
    name: str
    role: Optional[str] = None
    bio: Optional[str] = None
    photo_path: Optional[str] = None


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
    icon_url: Optional[str] = None  # card art image; empty string clears it
    card_cta: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None
    status: Optional[TripStatus] = None  # defaults to 'upcoming' when omitted
    theme: Optional[TripTheme] = None  # defaults to 'enamel' when omitted


class UpdateTripBody(BaseModel):
    title: Optional[str] = None
    slug: Optional[str] = None
    eyebrow: Optional[str] = None
    headline: Optional[str] = None
    lede: Optional[str] = None
    photo_album_url: Optional[str] = None
    icon_url: Optional[str] = None  # card art image; empty string clears it
    card_cta: Optional[str] = None
    sort_order: Optional[int] = None
    is_published: Optional[bool] = None
    status: Optional[TripStatus] = None
    theme: Optional[TripTheme] = None


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


class UpdateProfileBody(BaseModel):
    """Partial update of the profile block — only non-null fields are changed.

    Photo editing is deliberately omitted for now (see person_profile.photo_path).
    """
    name: Optional[str] = None
    role: Optional[str] = None
    bio: Optional[str] = None
