"""Community pool models: privacy-safe place aggregates across all users."""

from typing import Optional

from pydantic import BaseModel, Field

from .core import GeoFacets


class CommunitySourceRef(BaseModel):
    """A public source chip on a community place — the URL is already public
    content; no capturer identity rides along."""
    url: str
    source_domain: Optional[str] = None
    og_title: Optional[str] = None


class CommunityPlaceResponse(BaseModel):
    """One aggregated place in the community catalog. Canonical facts only —
    never another user's notes, ratings, vibes, or identity."""
    ref_place_id: str = Field(..., description="A representative place row to save from")
    name: str
    city: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    category: str = "other"
    lat: Optional[float] = None
    lng: Optional[float] = None
    maps_url: Optional[str] = None
    og_image_url: Optional[str] = None
    saved_by_count: int = Field(1, description="Distinct travelers who saved this place")
    source_count: int = 0
    sample_sources: list[CommunitySourceRef] = []


class CommunityPlacesResponse(BaseModel):
    places: list[CommunityPlaceResponse] = []     # one filtered page
    total: int = 0                                # filtered count across pages
    facets: GeoFacets = GeoFacets()


class CommunitySaveRequest(BaseModel):
    trip_id: Optional[str] = Field(
        None, description="Save straight into this trip (approved); omit for the Wander List")


class SuggestionCategoryFacet(BaseModel):
    """One entry in a trip suggestion picker's type filter: a category present
    in the trip-scoped pool, with how many suggestions carry it."""
    slug: str
    label: str
    icon: str = "other"
    count: int = 0


class TripSuggestionItem(BaseModel):
    """One ranked suggestion for a trip's add picker. Merges the two pools:
    `source='wander'` items carry `scrap_id` (assigned straight to the trip);
    `source='community'` items carry only canonical facts (saved via
    `ref_place_id`). `dist_km` is the haversine distance to the trip's plan
    centroid used for ranking (null when neither has coordinates)."""
    source: str = Field(..., description="'wander' | 'community'")
    scrap_id: Optional[str] = Field(None, description="Wander items: the viewer's scrap to assign")
    ref_place_id: str = Field(..., description="Representative place row (community save / dedupe)")
    name: str
    city: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    category: str = "other"
    lat: Optional[float] = None
    lng: Optional[float] = None
    maps_url: Optional[str] = None
    og_image_url: Optional[str] = None
    saved_by_count: int = 0
    dist_km: Optional[float] = None


class TripSuggestionsResponse(BaseModel):
    """One proximity-ranked page of the unified add picker plus the type-filter
    facet over the whole trip-scoped pool."""
    items: list[TripSuggestionItem] = []
    total: int = 0
    categories: list[SuggestionCategoryFacet] = []
