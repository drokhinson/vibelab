"""Pydantic request/response models for the person (personal page) API."""

from typing import List, Optional

from pydantic import BaseModel

from .constants import TripStatus, TripTheme


# ── Responses ────────────────────────────────────────────────────────────────
class TripSummaryResponse(BaseModel):
    """A trip as shown on the about-page card grid (no stops).

    "Summary" here means the summarised *card* shape, and has nothing to do with
    a trip's recap document (`summary_html`) — that lives on TripDetailResponse
    and TripSummaryDocResponse below. This model must stay small: it is what
    GET /trips returns for every trip on every about-page load.
    """
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
    """A trip plus its ordered stops (each with full html_content).

    Carries the recap's *labels* and a flag, never the recap document: the
    document runs to hundreds of KB and is fetched on demand by
    GET /trips/{slug}/summary only when a reader opens it.
    """
    summary_title: Optional[str] = None
    summary_caption: Optional[str] = None
    has_summary: bool = False
    stops: List[StopResponse] = []


class TripSummaryDocResponse(BaseModel):
    """A trip's whole-trip recap: one standalone HTML page about the journey.

    Fetched on its own so the trip page stays light for the readers who never
    open it. Named "Doc" to keep it apart from TripSummaryResponse, which is the
    about-page card shape.
    """
    slug: str
    title: Optional[str] = None
    caption: Optional[str] = None
    html: str


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
    # Recap labels only. The document itself is attached from the trip page once
    # the trip exists (PUT /admin/trips/{id}), never at creation.
    summary_title: Optional[str] = None  # blank stores NULL
    summary_caption: Optional[str] = None  # blank stores NULL


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
    # The whole-trip recap. All three are clearable: a blank string is written
    # (unlike null, which is skipped) and normalised to NULL, which drops
    # has_summary back to false. See update_trip in trip_routes.py.
    summary_html: Optional[str] = None  # empty string clears it
    summary_title: Optional[str] = None  # empty string clears it
    summary_caption: Optional[str] = None  # empty string clears it


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
