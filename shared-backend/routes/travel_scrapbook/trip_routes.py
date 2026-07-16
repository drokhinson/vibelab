"""Trip CRUD and anchor (start/end/stay) management."""

from typing import Any

from fastapi import BackgroundTasks, Depends, HTTPException, Path

from db import get_supabase

from . import router
from .constants import AnchorRole, GeocodeConfidence, ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import (
    AnchorCreateRequest,
    AnchorResponse,
    AnchorUpdateRequest,
    MessageResponse,
    ScrapResponse,
    TripCreateRequest,
    TripListResponse,
    TripResponse,
    TripSummaryResponse,
    TripUpdateRequest,
)
from .services import nominatim
from .services.hydrate import hydrate_scraps
from .services.places import geocode_trip_destination


def get_owned_trip(sb, trip_id: str, user_id: str) -> dict[str, Any]:
    """Fetch a trip row, 404ing when missing or owned by someone else."""
    rows = (
        sb.table("travelscrapbook_trips")
        .select("*")
        .eq("id", trip_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Trip not found")
    return rows.data[0]


async def _geocode_anchor(query: str) -> dict[str, Any]:
    result = await nominatim.geocode(query)
    if result:
        return {
            "lat": result.lat,
            "lng": result.lng,
            "geocode_confidence": GeocodeConfidence.HIGH,
        }
    return {"lat": None, "lng": None, "geocode_confidence": GeocodeConfidence.NONE}


def _get_start_anchor(sb, trip_id: str) -> dict[str, Any] | None:
    """The trip's start anchor, if one exists (used to copy into the end)."""
    rows = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .eq("role", AnchorRole.START)
        .execute()
    )
    return rows.data[0] if rows.data else None


def _validate_stay_date(trip: dict[str, Any], stay_date: str | None) -> None:
    """Reject a stay's check-in day that falls outside the trip's dates.

    Lenient when either trip bound is unset. Dates are ISO 'YYYY-MM-DD' strings,
    so lexical comparison is chronological.
    """
    if not stay_date:
        return
    start, end = trip.get("start_date"), trip.get("end_date")
    if (start and stay_date < start) or (end and stay_date > end):
        raise HTTPException(
            status_code=400,
            detail="Check-in day must fall within the trip's dates",
        )


async def _backfill_trip_geocodes(trip_ids: list[str]) -> None:
    """Lazy backfill: geocode destinations that have never been attempted.
    Serial — nominatim.py enforces the courtesy throttle."""
    sb = get_supabase()
    for trip_id in trip_ids:
        rows = (
            sb.table("travelscrapbook_trips")
            .select("id, destination, destination_geocoded_at")
            .eq("id", trip_id)
            .execute()
        ).data
        if rows and rows[0].get("destination") and not rows[0].get("destination_geocoded_at"):
            await geocode_trip_destination(sb, rows[0])


@router.get(
    "/trips",
    response_model=TripListResponse,
    status_code=200,
    summary="List my trips",
)
async def list_trips(
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> TripListResponse:
    """All trips for the current user, newest first, with scrap counts."""
    sb = get_supabase()
    rows = (
        sb.table("travelscrapbook_trips")
        .select("id, name, destination, cover_icon, start_date, end_date, created_at, "
                "destination_geocoded_at, travelscrapbook_scraps(count)")
        .eq("user_id", user.user_id)
        .order("created_at", desc=True)
        .execute()
    )
    trips = []
    pending_geocode = []
    for r in rows.data or []:
        counts = r.pop("travelscrapbook_scraps", [])
        if r.get("destination") and not r.pop("destination_geocoded_at", None):
            pending_geocode.append(r["id"])
        else:
            r.pop("destination_geocoded_at", None)
        scrap_count = counts[0]["count"] if counts else 0
        trips.append(TripSummaryResponse(**r, scrap_count=scrap_count))
    if pending_geocode:
        background_tasks.add_task(_backfill_trip_geocodes, pending_geocode)
    return TripListResponse(trips=trips)


@router.post(
    "/trips",
    response_model=TripSummaryResponse,
    status_code=201,
    summary="Create a trip",
)
async def create_trip(
    body: TripCreateRequest,
    user: CurrentUser = Depends(get_current_user),
) -> TripSummaryResponse:
    """Create a new trip owned by the current user."""
    sb = get_supabase()
    row = {
        "user_id": user.user_id,
        "name": body.name,
        "destination": body.destination,
        "cover_icon": body.cover_icon,
        "start_date": body.start_date.isoformat() if body.start_date else None,
        "end_date": body.end_date.isoformat() if body.end_date else None,
        "notes": body.notes,
    }
    created = sb.table("travelscrapbook_trips").insert(row).execute()
    trip = created.data[0]
    if body.destination:
        # Sync, like anchors — one Nominatim call so staging auto-match works
        # for scraps captured right after trip creation.
        trip = await geocode_trip_destination(sb, trip)
    return TripSummaryResponse(**trip, scrap_count=0)


@router.get(
    "/trips/{trip_id}",
    response_model=TripResponse,
    status_code=200,
    summary="Get a trip bundle",
)
async def get_trip(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TripResponse:
    """Trip with its anchors and scraps (approved and staged split out) —
    everything the trip view needs."""
    sb = get_supabase()
    trip = get_owned_trip(sb, trip_id, user.user_id)
    anchors = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .order("created_at")
        .execute()
    )
    scraps = hydrate_scraps(
        sb,
        (
            sb.table("travelscrapbook_scraps")
            .select("*")
            .eq("trip_id", trip_id)
            .order("created_at", desc=True)
            .execute()
        ).data or [],
    )
    return TripResponse(
        **trip,
        anchors=anchors.data or [],
        scraps=[ScrapResponse(**s) for s in scraps if s["status"] == ScrapStatus.APPROVED],
        staged_scraps=[ScrapResponse(**s) for s in scraps if s["status"] == ScrapStatus.STAGED],
    )


@router.patch(
    "/trips/{trip_id}",
    response_model=TripSummaryResponse,
    status_code=200,
    summary="Update a trip",
)
async def update_trip(
    body: TripUpdateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> TripSummaryResponse:
    """Edit trip fields; only provided fields change. A changed destination is
    re-geocoded synchronously."""
    sb = get_supabase()
    existing = get_owned_trip(sb, trip_id, user.user_id)
    update = {
        k: (v.isoformat() if hasattr(v, "isoformat") else v)
        for k, v in body.model_dump(exclude_unset=True).items()
    }
    update["updated_at"] = "now()"
    updated = (
        sb.table("travelscrapbook_trips").update(update).eq("id", trip_id).execute()
    )
    trip = updated.data[0]
    if "destination" in update and update["destination"] != existing.get("destination"):
        trip = await geocode_trip_destination(sb, trip)
    return TripSummaryResponse(**trip, scrap_count=0)


@router.delete(
    "/trips/{trip_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a trip",
)
async def delete_trip(
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Delete a trip; scraps and anchors cascade."""
    sb = get_supabase()
    get_owned_trip(sb, trip_id, user.user_id)
    sb.table("travelscrapbook_trips").delete().eq("id", trip_id).execute()
    return MessageResponse(message="Trip deleted")


# ── Anchors ───────────────────────────────────────────────────────────────────

@router.post(
    "/trips/{trip_id}/anchors",
    response_model=AnchorResponse,
    status_code=201,
    summary="Add a route anchor",
)
async def create_anchor(
    body: AnchorCreateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> AnchorResponse:
    """Add a start/end/stay anchor.

    Normal anchors geocode their query synchronously. An end anchor with
    ``same_as_start`` copies the start anchor's place + type instead (arrival and
    departure are often the same spot), skipping the geocode entirely.
    """
    sb = get_supabase()
    trip = get_owned_trip(sb, trip_id, user.user_id)

    if body.same_as_start:
        if body.role != AnchorRole.END:
            raise HTTPException(
                status_code=400, detail="Only the end anchor can copy the start")
        start = _get_start_anchor(sb, trip_id)
        if not start:
            raise HTTPException(status_code=400, detail="Add a start anchor first")
        row = {
            "trip_id": trip_id,
            "role": AnchorRole.END,
            "label": start["label"],
            "query": start["query"],
            "lat": start.get("lat"),
            "lng": start.get("lng"),
            "geocode_confidence": start.get("geocode_confidence", GeocodeConfidence.NONE),
            "type": start.get("type"),
        }
    else:
        row = {
            "trip_id": trip_id,
            "role": body.role,
            "label": body.label,
            "query": body.query,
            **(await _geocode_anchor(body.query)),
            # type only applies to route endpoints; stay_date only to lodging.
            "type": body.type if body.role in (AnchorRole.START, AnchorRole.END) else None,
            "stay_date": (
                body.stay_date.isoformat()
                if body.role == AnchorRole.STAY and body.stay_date else None
            ),
        }
        _validate_stay_date(trip, row["stay_date"])

    try:
        created = sb.table("travelscrapbook_anchors").insert(row).execute()
    except Exception as exc:
        # Partial unique index: one start + one end per trip.
        raise HTTPException(
            status_code=409,
            detail=f"Trip already has a '{body.role}' anchor",
        ) from exc
    return AnchorResponse(**created.data[0])


def _get_owned_anchor(sb, anchor_id: str, user_id: str) -> dict[str, Any]:
    rows = (
        sb.table("travelscrapbook_anchors")
        .select("*, travelscrapbook_trips!inner(user_id)")
        .eq("id", anchor_id)
        .eq("travelscrapbook_trips.user_id", user_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Anchor not found")
    row = rows.data[0]
    row.pop("travelscrapbook_trips", None)
    return row


@router.patch(
    "/anchors/{anchor_id}",
    response_model=AnchorResponse,
    status_code=200,
    summary="Update an anchor",
)
async def update_anchor(
    body: AnchorUpdateRequest,
    anchor_id: str = Path(..., description="Anchor UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> AnchorResponse:
    """Edit label/query; a changed query is re-geocoded synchronously."""
    sb = get_supabase()
    existing = _get_owned_anchor(sb, anchor_id, user.user_id)
    update = {
        k: (v.isoformat() if hasattr(v, "isoformat") else v)
        for k, v in body.model_dump(exclude_unset=True).items()
    }
    if "query" in update and update["query"] != existing["query"]:
        update.update(await _geocode_anchor(update["query"]))
    updated = (
        sb.table("travelscrapbook_anchors").update(update).eq("id", anchor_id).execute()
    )
    return AnchorResponse(**updated.data[0])


@router.delete(
    "/anchors/{anchor_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete an anchor",
)
async def delete_anchor(
    anchor_id: str = Path(..., description="Anchor UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove an anchor from its trip."""
    sb = get_supabase()
    _get_owned_anchor(sb, anchor_id, user.user_id)
    sb.table("travelscrapbook_anchors").delete().eq("id", anchor_id).execute()
    return MessageResponse(message="Anchor deleted")
