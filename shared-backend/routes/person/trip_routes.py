"""Trip routes for the personal page: public reads + admin-gated CRUD."""

import re
from datetime import datetime, timezone
from enum import StrEnum
from typing import List, Optional

from fastapi import Header, HTTPException, Path

from auth import require_admin
from db import get_supabase
from shared_models import HealthResponse

from . import router
from .constants import TripStatus, TripTheme
from .models import (
    CreateTripBody,
    MessageResponse,
    TripDetailResponse,
    TripSummaryDocResponse,
    TripSummaryResponse,
    UpdateTripBody,
)

# Columns for the card/summary shape — never selects html_content (not on trips).
_TRIP_COLS = (
    "id, slug, title, eyebrow, headline, lede, photo_album_url, icon_url, "
    "card_cta, sort_order, is_published, status, theme"
)
# The trip page needs to know a recap EXISTS (to paint its banner) without
# paying for it. has_summary is a generated column, so this stays cheap;
# summary_html is deliberately absent and is served by get_trip_summary below.
# Never fold these into _TRIP_COLS — that is what /trips selects for every trip
# on every about-page load.
_TRIP_DETAIL_COLS = _TRIP_COLS + ", summary_title, summary_caption, has_summary"
# Blank means "cleared" for these: the update loop skips None, so the frontend
# sends "" to unset a field, and it is stored as NULL so has_summary recomputes.
_SUMMARY_FIELDS = ("summary_html", "summary_title", "summary_caption")
# Full stop rows for the trip-detail endpoint: html_content is included so the
# trip page loads all stops in one pass (the trip UI opens popups from memory).
_STOP_COLS = "id, trip_id, title, meta, note, sort_order, html_content"


def _slugify(text: str) -> str:
    """Lowercase, non-alnum → hyphen, collapse repeats, strip ends."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "trip"


def _blank_to_none(data: dict) -> None:
    """Rewrite blank recap strings to NULL in place, so has_summary recomputes."""
    for field in _SUMMARY_FIELDS:
        value = data.get(field)
        if isinstance(value, str) and not value.strip():
            data[field] = None


def _unique_slug(base: str) -> str:
    """Return `base`, or base-2, base-3… so the slug is unique in person_trips."""
    sb = get_supabase()
    existing = sb.table("person_trips").select("slug").execute()
    taken = {row["slug"] for row in (existing.data or [])}
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


@router.get("/health", response_model=HealthResponse, status_code=200, summary="Health check")
async def health() -> HealthResponse:
    """Return service status for the person API."""
    return HealthResponse(project="person", status="ok")


@router.get(
    "/admin/verify",
    response_model=MessageResponse,
    status_code=200,
    summary="Validate an admin key",
)
async def admin_verify(authorization: Optional[str] = Header(None)) -> MessageResponse:
    """Admin: cheap endpoint the frontend probes to confirm the admin key is valid."""
    require_admin(authorization)
    return MessageResponse(status="ok")


@router.get(
    "/trips",
    response_model=List[TripSummaryResponse],
    status_code=200,
    summary="List published trips (card grid)",
)
async def list_trips() -> List[dict]:
    """Public: all published trips ordered for the about-page card grid."""
    sb = get_supabase()
    result = (
        sb.table("person_trips")
        .select(_TRIP_COLS)
        .eq("is_published", True)
        .order("sort_order")
        .execute()
    )
    return result.data or []


@router.get(
    "/trips/{slug}",
    response_model=TripDetailResponse,
    status_code=200,
    summary="Get one trip by slug with its stops",
)
async def get_trip(
    slug: str = Path(..., description="Trip URL slug"),
) -> dict:
    """Public: a trip plus its ordered stops, and whether it has a recap."""
    sb = get_supabase()
    trip_res = sb.table("person_trips").select(_TRIP_DETAIL_COLS).eq("slug", slug).execute()
    if not trip_res.data:
        raise HTTPException(status_code=404, detail="Trip not found")
    trip = trip_res.data[0]

    stops_res = (
        sb.table("person_trip_stops")
        .select(_STOP_COLS)
        .eq("trip_id", trip["id"])
        .order("sort_order")
        .execute()
    )
    trip["stops"] = stops_res.data or []
    return trip


@router.get(
    "/trips/{slug}/summary",
    response_model=TripSummaryDocResponse,
    status_code=200,
    summary="Get one trip's whole-trip recap document",
)
async def get_trip_summary(
    slug: str = Path(..., description="Trip URL slug"),
) -> dict:
    """Public: the trip's recap HTML page, fetched only when a reader opens it."""
    sb = get_supabase()
    res = (
        sb.table("person_trips")
        .select("slug, summary_title, summary_caption, summary_html")
        .eq("slug", slug)
        .execute()
    )
    # A trip with no recap is a 404 rather than an empty 200: the frontend treats
    # this the same as a stale stop number and falls back to the trip page.
    if not res.data or not (res.data[0].get("summary_html") or "").strip():
        raise HTTPException(status_code=404, detail="Trip summary not found")
    row = res.data[0]
    return {
        "slug": row["slug"],
        "title": row.get("summary_title"),
        "caption": row.get("summary_caption"),
        "html": row["summary_html"],
    }


@router.post(
    "/admin/trips",
    response_model=TripSummaryResponse,
    status_code=201,
    summary="Create a trip",
)
async def create_trip(
    body: CreateTripBody,
    authorization: Optional[str] = Header(None),
) -> dict:
    """Admin: create a trip. Slug is derived from the title unless provided."""
    require_admin(authorization)
    sb = get_supabase()

    slug_base = _slugify(body.slug or body.title)
    slug = _unique_slug(slug_base)

    trip_data = {
        "slug": slug,
        "title": body.title,
        "eyebrow": body.eyebrow,
        "headline": body.headline,
        "lede": body.lede,
        "photo_album_url": body.photo_album_url,
        "icon_url": body.icon_url,
        "card_cta": body.card_cta,
        # Recap labels only — the document is attached later from the trip page.
        "summary_title": body.summary_title,
        "summary_caption": body.summary_caption,
        "sort_order": body.sort_order if body.sort_order is not None else 0,
        "is_published": body.is_published if body.is_published is not None else True,
        # A trip is announced before it is lived, so an unstated status is
        # 'upcoming' — the admin flips it to 'live' when the trip starts.
        "status": str(body.status if body.status is not None else TripStatus.UPCOMING),
        # The palette the section already had, so an unstated theme leaves the
        # trip looking exactly like every trip before it.
        "theme": str(body.theme if body.theme is not None else TripTheme.ENAMEL),
    }
    _blank_to_none(trip_data)
    result = sb.table("person_trips").insert(trip_data).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create trip")
    return result.data[0]


@router.put(
    "/admin/trips/{trip_id}",
    response_model=TripSummaryResponse,
    status_code=200,
    summary="Update a trip",
)
async def update_trip(
    body: UpdateTripBody,
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> dict:
    """Admin: update a trip's fields. Only non-null fields are changed."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("person_trips").select("id").eq("id", trip_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    # Note: only non-None fields are written, so a field can't be cleared by
    # sending null. `icon_url` is clearable because the frontend sends "" for a
    # blanked input rather than null (see landing/about-travel.js); the three
    # summary_* fields work the same way (see landing/trip-admin.js).
    update_data: dict = {}
    for field in [
        "title", "eyebrow", "headline", "lede",
        "photo_album_url", "icon_url", "card_cta", "sort_order", "is_published",
        "status", "theme", *_SUMMARY_FIELDS,
    ]:
        val = getattr(body, field)
        if val is not None:
            # StrEnum members serialise as their value, but str() keeps the
            # payload plain for the Supabase client. Checked against StrEnum
            # rather than each enum in turn, so a new one needs no branch here.
            update_data[field] = str(val) if isinstance(val, StrEnum) else val
    if body.slug is not None:
        update_data["slug"] = _unique_slug(_slugify(body.slug))
    # "" arrived above as a real write; store it as NULL so the generated
    # has_summary column drops back to false rather than seeing an empty string.
    _blank_to_none(update_data)

    if update_data:
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        result = sb.table("person_trips").update(update_data).eq("id", trip_id).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update trip")

    updated = sb.table("person_trips").select(_TRIP_COLS).eq("id", trip_id).execute()
    return updated.data[0]


@router.delete(
    "/admin/trips/{trip_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a trip",
)
async def delete_trip(
    trip_id: str = Path(..., description="Trip ID"),
    authorization: Optional[str] = Header(None),
) -> MessageResponse:
    """Admin: delete a trip; its stops are removed via ON DELETE CASCADE."""
    require_admin(authorization)
    sb = get_supabase()

    existing = sb.table("person_trips").select("id").eq("id", trip_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Trip not found")

    sb.table("person_trips").delete().eq("id", trip_id).execute()
    return MessageResponse(status="deleted", id=trip_id)
