"""Pydantic request/response models for Travel Scrapbook."""

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, Field, HttpUrl, model_validator

from .constants import AnchorRole, AnchorType, GeocodeConfidence, ScrapStatus


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


# ── Anchors ───────────────────────────────────────────────────────────────────

class AnchorCreateRequest(BaseModel):
    role: AnchorRole
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    query: Optional[str] = Field(None, min_length=2, max_length=300,
                                 description="Freeform place text to geocode, e.g. 'Narita Airport'")
    type: Optional[AnchorType] = Field(
        None, description="How you arrive/depart (start/end anchors only)")
    stay_date: Optional[date] = Field(
        None, description="Check-in day for a stay anchor; a day within the trip's dates")
    same_as_start: bool = Field(
        False,
        description="Copy the trip's start anchor (location + type) into this end anchor; skips geocoding")

    @model_validator(mode="after")
    def _require_place(self) -> "AnchorCreateRequest":
        # label/query are copied from the start anchor when same_as_start is set;
        # otherwise the user must supply both to geocode a real place.
        if not self.same_as_start and (not self.label or not self.query):
            raise ValueError("label and query are required unless same_as_start is set")
        return self


class AnchorUpdateRequest(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    query: Optional[str] = Field(None, min_length=2, max_length=300)
    type: Optional[AnchorType] = None
    stay_date: Optional[date] = None


class AnchorResponse(BaseModel):
    id: str
    trip_id: str
    role: AnchorRole
    label: str
    query: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    geocode_confidence: GeocodeConfidence = GeocodeConfidence.NONE
    type: Optional[AnchorType] = None
    stay_date: Optional[date] = None
    created_at: datetime


# ── Scraps ────────────────────────────────────────────────────────────────────

class ScrapCreateRequest(BaseModel):
    trip_id: str
    url: HttpUrl
    notes: Optional[str] = Field(None, max_length=2000)


class ScrapUpdateRequest(BaseModel):
    place_name: Optional[str] = Field(None, max_length=200)
    place_city: Optional[str] = Field(None, max_length=120)
    place_country: Optional[str] = Field(None, max_length=120)
    category: Optional[str] = None
    notes: Optional[str] = Field(None, max_length=2000)
    is_favorite: Optional[bool] = None
    regeocode: bool = Field(False, description="Re-run Nominatim on the edited place fields")


class ScrapResponse(BaseModel):
    id: str
    trip_id: str
    source_url: str
    source_domain: Optional[str] = None
    status: ScrapStatus
    error_kind: Optional[str] = None
    og_title: Optional[str] = None
    og_description: Optional[str] = None
    og_image_url: Optional[str] = None
    place_name: Optional[str] = None
    place_city: Optional[str] = None
    place_country: Optional[str] = None
    category: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    geocode_confidence: GeocodeConfidence = GeocodeConfidence.NONE
    geocode_display_name: Optional[str] = None
    maps_url: Optional[str] = None
    notes: Optional[str] = None
    is_favorite: bool = False
    route_position: Optional[int] = None
    created_at: datetime
    updated_at: datetime


# ── Trips ─────────────────────────────────────────────────────────────────────

class TripCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    destination: Optional[str] = Field(None, max_length=160)
    cover_icon: str = Field("plane", max_length=40,
                            description="Cover sticker sprite slug")
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = Field(None, max_length=4000)


class TripUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    destination: Optional[str] = Field(None, max_length=160)
    cover_icon: Optional[str] = Field(None, max_length=40)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = Field(None, max_length=4000)


class TripSummaryResponse(BaseModel):
    id: str
    name: str
    destination: Optional[str] = None
    cover_icon: str
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    scrap_count: int = 0
    created_at: datetime


class TripResponse(BaseModel):
    id: str
    name: str
    destination: Optional[str] = None
    cover_icon: str
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    anchors: list[AnchorResponse] = []
    scraps: list[ScrapResponse] = []


class TripListResponse(BaseModel):
    trips: list[TripSummaryResponse]


class ScrapListResponse(BaseModel):
    scraps: list[ScrapResponse]


# ── Route optimization ────────────────────────────────────────────────────────

class RouteOptimizeRequest(BaseModel):
    scrap_ids: Optional[list[str]] = Field(
        None, description="Restrict to these scraps; default = all geocoded scraps in the trip")
    favorites_only: bool = False


class RouteLeg(BaseModel):
    from_label: str
    to_label: str
    distance_km: float


class RouteOptimizeResponse(BaseModel):
    ordered_scraps: list[ScrapResponse]
    legs: list[RouteLeg]
    total_km: float
    skipped_scrap_ids: list[str] = Field(
        default_factory=list, description="Scraps without coordinates, left out of the route")


# ── Exports ───────────────────────────────────────────────────────────────────

class MapsLeg(BaseModel):
    label: str
    url: str
    stop_count: int


class MapsLinksResponse(BaseModel):
    legs: list[MapsLeg]
