"""Core models: profile, capture/sources, scraps, and the inbox."""

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field, HttpUrl

from ..constants import (
    CapturedVia,
    GeocodeConfidence,
    ScrapStatus,
    SourceStatus,
    TripVibe,
)


# ── Shared ────────────────────────────────────────────────────────────────────

class MessageResponse(BaseModel):
    message: str


class CategoryResponse(BaseModel):
    slug: str
    label: str
    icon: str  # sprite slug → assets/sprites/categories/travel-scrapbook-cat-<icon>.svg
    sort_order: int


# ── Profile ───────────────────────────────────────────────────────────────────

class ProfileResponse(BaseModel):
    user_id: str
    display_name: str
    username: str
    is_admin: bool
    categories: list[CategoryResponse]


class ProfileUpdateRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=60)


# ── Capture / sources ─────────────────────────────────────────────────────────

class CaptureRequest(BaseModel):
    """A shared/pasted URL. Android share sheets often put the URL inside
    `text`, so either field may carry it; the first http(s) URL wins."""
    url: Optional[HttpUrl] = None
    text: Optional[str] = Field(None, max_length=4000,
                                description="Share-sheet text; may contain the URL and a caption")
    title: Optional[str] = Field(None, max_length=300)
    trip_id: Optional[str] = Field(None, description="Explicit trip pick — skips staging review")
    via: CapturedVia = Field(CapturedVia.PASTE,
                             description="How the URL arrived (token-authed requests force 'shortcut')")
    notes: Optional[str] = Field(None, max_length=2000)


class SourceRef(BaseModel):
    """Compact source chip shown on a scrap card."""
    id: str
    url: str
    source_domain: Optional[str] = None
    og_title: Optional[str] = None


class SourceResponse(BaseModel):
    id: str
    url: str
    source_domain: Optional[str] = None
    status: SourceStatus
    error_kind: Optional[str] = None
    captured_via: CapturedVia = CapturedVia.PASTE
    og_title: Optional[str] = None
    og_image_url: Optional[str] = None
    trip_hint_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class CaptureTokenCreateResponse(BaseModel):
    token: str = Field(..., description="Shown once — store it in the iOS Shortcut")
    created_at: datetime


class CaptureTokenStatusResponse(BaseModel):
    active: bool
    created_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


# ── Scraps ────────────────────────────────────────────────────────────────────

class ScrapUpdateRequest(BaseModel):
    place_name: Optional[str] = Field(None, max_length=200)
    place_city: Optional[str] = Field(None, max_length=120)
    # region is derived from the country (macro-region), never user-set.
    place_country: Optional[str] = Field(None, max_length=120)
    category: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=2000)
    visited: Optional[bool] = Field(
        None, description="Mark visited (been there) or move back to the wishlist")
    regeocode: bool = Field(False, description="Re-run Nominatim on the edited place fields")


class RatingRequest(BaseModel):
    """The owner's own priority on a saved place (same levels as trip vibes)."""
    level: TripVibe


class ScrapVibe(BaseModel):
    """One traveler's vibe on a scrap (a single consensus input)."""
    user_id: str
    display_name: str
    level: TripVibe


class ScrapConsensus(BaseModel):
    """Group roll-up of a scrap's vibes, computed in hydrate.py."""
    counts: dict[TripVibe, int] = {}
    total: int = 0
    headline: str = ""


class ScrapResponse(BaseModel):
    """A saved place, in a trip or the inbox. Place fields are flattened from
    the canonical place row; sources list how the user stumbled on it. On shared
    trips, `added_by_*` names the collaborator who saved it and `vibes`/
    `consensus` carry every traveler's take."""
    id: str
    trip_id: Optional[str] = None
    place_id: str
    status: ScrapStatus
    place_name: Optional[str] = None
    place_city: Optional[str] = None
    place_region: Optional[str] = None
    place_country: Optional[str] = None
    category: str = "other"
    lat: Optional[float] = None
    lng: Optional[float] = None
    geocode_confidence: GeocodeConfidence = GeocodeConfidence.NONE
    geocode_display_name: Optional[str] = None
    maps_url: Optional[str] = None
    og_image_url: Optional[str] = None
    sources: list[SourceRef] = []
    notes: Optional[str] = None
    rating: Optional[TripVibe] = None             # owner's own priority
    visited_at: Optional[datetime] = None
    route_position: Optional[int] = None
    added_by_user_id: Optional[str] = None       # scrap owner (who saved it)
    added_by_display_name: Optional[str] = None
    vibes: list[ScrapVibe] = []                   # populated on trip surfaces only
    consensus: Optional[ScrapConsensus] = None
    created_at: datetime
    updated_at: datetime


class AssignRequest(BaseModel):
    trip_id: str


class AssignManyRequest(BaseModel):
    """Bulk-add several wishlist scraps to a trip (the 'From your Wander List'
    multi-select)."""
    scrap_ids: list[str] = Field(..., min_length=1)


class TripWishlistScrap(ScrapResponse):
    """A wishlist scrap annotated with whether it matches the trip's scope, for
    the trip's 'add plans' picker (scope-matches sort first)."""
    fits_scope: bool = False


class TripWishlistResponse(BaseModel):
    scraps: list[TripWishlistScrap] = []


class ScrapListResponse(BaseModel):
    scraps: list[ScrapResponse]


class SourceScrapsResponse(BaseModel):
    """A capture's live progress: its processing status + the scraps it created
    so far — drives the 'watch it import' cards on the share success screen."""
    status: SourceStatus
    error_kind: Optional[str] = None
    scraps: list[ScrapResponse] = []


# ── Inbox ─────────────────────────────────────────────────────────────────────

class TripSuggestion(BaseModel):
    trip_id: str
    name: str
    cover_icon: str = "plane"
    distance_km: float


class InboxScrapResponse(ScrapResponse):
    suggestions: list[TripSuggestion] = []


class InboxResponse(BaseModel):
    processing_sources: list[SourceResponse] = []
    failed_sources: list[SourceResponse] = []
    scraps: list[InboxScrapResponse] = []


class InboxCountResponse(BaseModel):
    count: int
