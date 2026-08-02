"""Pydantic request/response models for TripGuide."""

from typing import Dict, List, Optional

from pydantic import BaseModel


# ── Color schemes ─────────────────────────────────────────────────────────────
class ColorSchemeResponse(BaseModel):
    slug: str
    name: str
    palette: Dict[str, str]
    sort_order: int


# ── Stops ─────────────────────────────────────────────────────────────────────
class StopResponse(BaseModel):
    id: str
    trip_id: str
    name: str
    description: Optional[str] = None
    content_html: str
    sort_order: int
    created_at: str
    updated_at: str


class CreateStopBody(BaseModel):
    name: str
    description: Optional[str] = None
    content_html: str = ""


class UpdateStopBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content_html: Optional[str] = None
    sort_order: Optional[int] = None


class ReorderBody(BaseModel):
    ordered_ids: List[str]


# ── Trips ─────────────────────────────────────────────────────────────────────
class TripResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    color_scheme: str
    sort_order: int
    created_at: str
    updated_at: str
    stop_count: int = 0


class TripBundleResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    color_scheme: str
    palette: Dict[str, str]
    sort_order: int
    created_at: str
    updated_at: str
    stops: List[StopResponse]


class CreateTripBody(BaseModel):
    name: str
    description: Optional[str] = None
    color_scheme: str = "alpine"


class UpdateTripBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color_scheme: Optional[str] = None
    sort_order: Optional[int] = None
