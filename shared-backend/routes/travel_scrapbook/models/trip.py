"""Trip models: anchors, trips, route optimization, and exports."""

from datetime import date, datetime, time
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from ..constants import (
    AnchorRole,
    AnchorType,
    GeocodeConfidence,
    TripMemberRole,
    TripScope,
)
from .core import ScrapResponse
from .social import TripMemberResponse


# ── Anchors ───────────────────────────────────────────────────────────────────

class AnchorCreateRequest(BaseModel):
    role: AnchorRole
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    query: Optional[str] = Field(None, min_length=2, max_length=300,
                                 description="Freeform place text to geocode, e.g. 'Narita Airport'")
    type: Optional[AnchorType] = Field(
        None, description="How you travel (start/end/travel anchors only)")
    anchor_date: Optional[date] = Field(
        None, description="Start: arrival day; end: departure day; travel: leg day (timeline marker)")
    anchor_time: Optional[time] = Field(
        None, description="Optional time on anchor_date; omit for an all-day point marker")
    stay_date: Optional[date] = Field(
        None, description="Check-in day for a stay anchor; a day within the trip's dates")
    stay_end_date: Optional[date] = Field(
        None, description="Check-out day for a stay anchor (≥ stay_date)")
    same_as_start: bool = Field(
        False,
        description="Copy the trip's start anchor (location + type, not the date) into this end anchor; skips geocoding")

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
    anchor_date: Optional[date] = None
    anchor_time: Optional[time] = None
    stay_date: Optional[date] = None
    stay_end_date: Optional[date] = None


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
    anchor_date: Optional[date] = None            # start: arrival; end: departure; travel: leg day
    anchor_time: Optional[time] = None            # NULL = all-day point marker
    stay_date: Optional[date] = None              # stay: check-in
    stay_end_date: Optional[date] = None          # stay: check-out
    created_at: datetime


# ── Trips ─────────────────────────────────────────────────────────────────────

class TripCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    destination: Optional[str] = Field(None, max_length=160)
    cover_icon: str = Field("plane", max_length=40,
                            description="Cover sticker sprite slug")
    scope_level: Optional[TripScope] = Field(
        None, description="Geographic granularity; inferred from the destination when omitted")
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = Field(None, max_length=4000)


class TripUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    destination: Optional[str] = Field(None, max_length=160)
    cover_icon: Optional[str] = Field(None, max_length=40)
    scope_level: Optional[TripScope] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = Field(None, max_length=4000)


class TripSummaryResponse(BaseModel):
    id: str
    name: str
    destination: Optional[str] = None
    cover_icon: str
    scope_level: TripScope = TripScope.CITY
    dest_city: Optional[str] = None
    dest_region: Optional[str] = None
    dest_country: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    scrap_count: int = 0
    role: TripMemberRole = TripMemberRole.OWNER   # caller's role on this trip
    owner_user_id: Optional[str] = None
    owner_display_name: Optional[str] = None      # set for trips shared with the caller
    created_at: datetime


class TripResponse(BaseModel):
    id: str
    name: str
    destination: Optional[str] = None
    cover_icon: str
    scope_level: TripScope = TripScope.CITY
    dest_city: Optional[str] = None
    dest_region: Optional[str] = None
    dest_country: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    notes: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    geocode_display_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    role: TripMemberRole = TripMemberRole.OWNER   # caller's role on this trip
    owner_user_id: Optional[str] = None
    owner_display_name: Optional[str] = None
    anchors: list[AnchorResponse] = []
    scraps: list[ScrapResponse] = []           # approved
    staged_scraps: list[ScrapResponse] = []    # auto-matched, awaiting review
    members: list[TripMemberResponse] = []     # owner first, pending invites included
    candidates: list[ScrapResponse] = []       # viewer's scope-matched wishlist adds (write roles)


class TripListResponse(BaseModel):
    trips: list[TripSummaryResponse]


# ── Route optimization ────────────────────────────────────────────────────────

class RouteOptimizeRequest(BaseModel):
    scrap_ids: Optional[list[str]] = Field(
        None, description="Restrict to these scraps; default = all geocoded scraps in the trip")
    priority_only: bool = Field(
        False, description="Route only booked / must-do plans")
    include_visited: bool = Field(
        False, description="Include places already marked visited (skipped by default)")


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
