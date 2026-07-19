"""Trip models: checkpoints, bookends, trips, route optimization, and exports."""

from datetime import date, datetime, time
from typing import Optional

from pydantic import BaseModel, Field, model_validator

from ..constants import (
    Bookend,
    CheckpointRole,
    CheckpointType,
    GeocodeConfidence,
    TripMemberRole,
    TripScope,
)
from .core import ScrapResponse
from .social import TripMemberResponse


# ── Checkpoints (stay/travel only; arrival/departure are Bookends) ────────────

class CheckpointCreateRequest(BaseModel):
    role: CheckpointRole
    label: str = Field(..., min_length=1, max_length=120)
    query: str = Field(..., min_length=2, max_length=300,
                       description="Freeform place text to geocode, e.g. 'Narita Airport'")
    maps_url: Optional[str] = Field(
        None, max_length=2000,
        description="A Google Maps link. When it's a real Maps place/pin URL, "
                    "coordinates + city/region/country are extracted from it (no AI).")
    type: Optional[CheckpointType] = Field(
        None, description="How you travel (travel checkpoints only)")
    checkpoint_date: Optional[date] = Field(
        None, description="travel: leg day (timeline marker)")
    checkpoint_time: Optional[time] = Field(
        None, description="Optional time on checkpoint_date; omit for an all-day point marker")
    stay_date: Optional[date] = Field(
        None, description="Check-in day for a stay checkpoint; a day within the trip's dates")
    stay_end_date: Optional[date] = Field(
        None, description="Check-out day for a stay checkpoint (≥ stay_date)")


class CheckpointUpdateRequest(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    query: Optional[str] = Field(None, min_length=2, max_length=300)
    maps_url: Optional[str] = Field(
        None, max_length=2000,
        description="A Google Maps link. When it's a real Maps place/pin URL, "
                    "coordinates + city/region/country are extracted from it (no AI).")
    type: Optional[CheckpointType] = None
    checkpoint_date: Optional[date] = None
    checkpoint_time: Optional[time] = None
    stay_date: Optional[date] = None
    stay_end_date: Optional[date] = None


class CheckpointResponse(BaseModel):
    id: str
    trip_id: str
    role: CheckpointRole
    label: str
    query: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    city: Optional[str] = None
    region: Optional[str] = None                   # macro-region, derived from country_code
    country: Optional[str] = None
    country_code: Optional[str] = None
    maps_url: Optional[str] = None                 # user-pasted Maps link, when provided
    geocode_confidence: GeocodeConfidence = GeocodeConfidence.NONE
    type: Optional[CheckpointType] = None
    # Unified-model links (020): the checkpoint's canonical place + the
    # creator's scrap. The checkpoint id itself is the trip-membership id.
    place_id: Optional[str] = None
    scrap_id: Optional[str] = None
    checkpoint_date: Optional[date] = None        # travel: leg day
    checkpoint_time: Optional[time] = None        # NULL = all-day point marker
    stay_date: Optional[date] = None              # stay: check-in
    stay_end_date: Optional[date] = None          # stay: check-out
    created_at: datetime


# ── Bookends (arrival / departure — ordinary bookend stops, 026) ──────────────

class BookendCreateRequest(BaseModel):
    which: Bookend
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    query: Optional[str] = Field(None, min_length=2, max_length=300,
                                 description="Freeform place text to geocode, e.g. 'Narita Airport'")
    maps_url: Optional[str] = Field(
        None, max_length=2000,
        description="A Google Maps link; a real Maps place/pin URL yields "
                    "coordinates + city/region/country (no AI).")
    type: Optional[CheckpointType] = Field(
        None, description="How you travel (airport/train_station/car_rental/other)")
    day: Optional[date] = Field(
        None, description="Arrival day (arrival) or departure day (departure), within the trip's dates")
    same_as_arrival: bool = Field(
        False,
        description="Departure only: reuse the arrival place (flag its stop as the "
                    "departure too) instead of geocoding a separate spot — but not its date")

    @model_validator(mode="after")
    def _require_place(self) -> "BookendCreateRequest":
        # label/query are reused from the arrival stop when same_as_arrival is
        # set; otherwise the user must supply both to geocode a real place.
        if not self.same_as_arrival and (not self.label or not self.query):
            raise ValueError("label and query are required unless same_as_arrival is set")
        return self


class BookendUpdateRequest(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=120)
    query: Optional[str] = Field(None, min_length=2, max_length=300)
    maps_url: Optional[str] = Field(None, max_length=2000)
    type: Optional[CheckpointType] = None
    day: Optional[date] = None


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
    checkpoints: list[CheckpointResponse] = []  # stay/travel (arrival/departure ride on scraps as flags)
    scraps: list[ScrapResponse] = []           # approved
    staged_scraps: list[ScrapResponse] = []    # auto-matched, awaiting review
    members: list[TripMemberResponse] = []     # owner first, pending invites included
    candidates: list[ScrapResponse] = []       # viewer's scope-matched wishlist adds (write roles)


class TripListResponse(BaseModel):
    trips: list[TripSummaryResponse]


# ── Exports ───────────────────────────────────────────────────────────────────

class MapsLeg(BaseModel):
    label: str
    url: str
    stop_count: int


class MapsLinksResponse(BaseModel):
    legs: list[MapsLeg]


class ExportItineraryItem(BaseModel):
    """One placed stop in the client's computed itinerary: which scrap, on which
    day (null = no day / "Anytime"). Order in the list IS the export order.
    (`plan_date` mirrors the frozen DB column name.)"""
    scrap_id: str
    plan_date: Optional[str] = None


class ExportRequest(BaseModel):
    """Optional body for the export endpoints. When present, `itinerary` is the
    client's timeline order — the authoritative order + per-stop day, including
    auto-placed stops the DB has no `plan_date` for. When absent (a plain GET),
    the server falls back to DB `route_position` / `plan_date`."""
    itinerary: Optional[list[ExportItineraryItem]] = None
