"""Timeline models: day-by-day markers + scheduled plans + slot suggestions."""

import datetime as dt
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .core import ScrapResponse

MarkerKind = Literal["arrival", "checkin", "checkout", "departure"]


class TimelineMarker(BaseModel):
    """A dated anchor event on the timeline (a stay contributes check-in and
    check-out separately)."""
    kind: MarkerKind
    anchor_id: str
    label: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    # dt-qualified: the field names shadow the bare date/time type names.
    date: dt.date
    time: Optional[dt.time] = None                # None = all-day point marker


class TimelineDay(BaseModel):
    date: dt.date
    day_number: int = Field(..., description="1-based day index within the trip")
    markers: list[TimelineMarker] = []
    plans: list[ScrapResponse] = []               # scheduled on this day, in time order


class TimelineSuggestion(BaseModel):
    """Where an unscheduled plan could slot in, by proximity to a marker."""
    scrap_id: str
    suggested_date: dt.date
    day_number: int
    marker_kind: MarkerKind
    marker_label: str
    distance_km: float


class UnscheduledPlan(ScrapResponse):
    suggestion: Optional[TimelineSuggestion] = None


class TimelineResponse(BaseModel):
    days: list[TimelineDay] = []
    unscheduled: list[UnscheduledPlan] = []
    reason: Optional[Literal["no_dates"]] = Field(
        None, description="Why the timeline is empty (no trip/anchor/plan dates at all)")
