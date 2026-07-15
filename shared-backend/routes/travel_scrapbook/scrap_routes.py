"""Scrap creation (the core save-a-link flow), polling, edits, and retry."""

from typing import Any
from urllib.parse import quote, urlparse

from fastapi import BackgroundTasks, Depends, HTTPException, Path

from db import get_supabase

from . import router
from .constants import GeocodeConfidence, ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    MessageResponse,
    ScrapCreateRequest,
    ScrapListResponse,
    ScrapResponse,
    ScrapUpdateRequest,
)
from .services import nominatim
from .services.enrichment import build_maps_url, enrich_scrap
from .trip_routes import get_owned_trip


def get_owned_scrap(sb, scrap_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("id", scrap_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Scrap not found")
    return rows.data[0]


def _domain(url: str) -> str:
    host = urlparse(url).hostname or ""
    return host.removeprefix("www.")


@router.post(
    "/scraps",
    response_model=ScrapResponse,
    status_code=201,
    summary="Scrap a URL",
)
async def create_scrap(
    body: ScrapCreateRequest,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Save a URL to a trip. Returns immediately with status='pending';
    scraping, place extraction, and geocoding run in the background."""
    sb = get_supabase()
    get_owned_trip(sb, body.trip_id, user.user_id)
    url = str(body.url)
    row = {
        "trip_id": body.trip_id,
        "user_id": user.user_id,
        "source_url": url,
        "source_domain": _domain(url),
        "notes": body.notes,
        "status": ScrapStatus.PENDING,
    }
    created = sb.table("travelscrapbook_scraps").insert(row).execute()
    scrap = created.data[0]
    background_tasks.add_task(enrich_scrap, scrap["id"])
    return ScrapResponse(**scrap)


@router.get(
    "/scraps/{scrap_id}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Get one scrap",
)
async def get_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Fetch a single scrap (used to poll enrichment progress)."""
    sb = get_supabase()
    return ScrapResponse(**get_owned_scrap(sb, scrap_id, user.user_id))


@router.get(
    "/trips/{trip_id}/scraps",
    response_model=ScrapListResponse,
    status_code=200,
    summary="List a trip's scraps",
)
async def list_scraps(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapListResponse:
    """All scraps in a trip, newest first."""
    sb = get_supabase()
    get_owned_trip(sb, trip_id, user.user_id)
    rows = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("trip_id", trip_id)
        .order("created_at", desc=True)
        .execute()
    )
    return ScrapListResponse(scraps=rows.data or [])


@router.patch(
    "/scraps/{scrap_id}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Edit a scrap",
)
async def update_scrap(
    body: ScrapUpdateRequest,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Edit place fields, category, notes, or favorite flag. Pass
    regeocode=true to re-run Nominatim on the (possibly edited) place."""
    sb = get_supabase()
    existing = get_owned_scrap(sb, scrap_id, user.user_id)

    update = body.model_dump(exclude_unset=True, exclude={"regeocode"})
    merged = {**existing, **update}

    if body.regeocode and (merged.get("place_name") or merged.get("place_city")):
        query = ", ".join(
            p for p in (
                merged.get("place_name"),
                merged.get("place_city"),
                merged.get("place_country"),
            ) if p
        )
        result = await nominatim.geocode(query)
        if result:
            update.update({
                "lat": result.lat,
                "lng": result.lng,
                "geocode_confidence": GeocodeConfidence.HIGH,
                "geocode_display_name": result.display_name,
            })
        else:
            update.update({
                "lat": None,
                "lng": None,
                "geocode_confidence": GeocodeConfidence.NONE,
                "geocode_display_name": None,
            })

    if merged.get("place_name") and (
        "place_name" in update or "place_city" in update or "place_country" in update
    ):
        update["maps_url"] = build_maps_url(
            merged["place_name"], merged.get("place_city"), merged.get("place_country")
        )

    # "Fill in by hand" recovery: a failed scrap the user gives a place name to
    # is now usable, so clear the failed state and render it as a saved place.
    if existing.get("status") == ScrapStatus.FAILED and merged.get("place_name"):
        update["status"] = ScrapStatus.READY
        update["error_kind"] = None

    if not update:
        return ScrapResponse(**existing)
    update["updated_at"] = "now()"
    updated = (
        sb.table("travelscrapbook_scraps").update(update).eq("id", scrap_id).execute()
    )
    return ScrapResponse(**updated.data[0])


@router.post(
    "/scraps/{scrap_id}/retry",
    response_model=ScrapResponse,
    status_code=202,
    summary="Retry enrichment",
)
async def retry_scrap(
    background_tasks: BackgroundTasks,
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Re-run the enrichment pipeline for a failed or stuck scrap."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    updated = (
        sb.table("travelscrapbook_scraps")
        .update({"status": ScrapStatus.PENDING, "error_kind": None, "updated_at": "now()"})
        .eq("id", scrap_id)
        .execute()
    )
    background_tasks.add_task(enrich_scrap, scrap_id)
    return ScrapResponse(**updated.data[0])


@router.delete(
    "/scraps/{scrap_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a scrap",
)
async def delete_scrap(
    scrap_id: str = Path(..., description="Scrap UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove a scrap from its trip."""
    sb = get_supabase()
    get_owned_scrap(sb, scrap_id, user.user_id)
    sb.table("travelscrapbook_scraps").delete().eq("id", scrap_id).execute()
    return MessageResponse(message="Scrap deleted")
