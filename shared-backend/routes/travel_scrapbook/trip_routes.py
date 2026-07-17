"""Trip CRUD and anchor (start/end/stay) management."""

from typing import Any

from fastapi import BackgroundTasks, Depends, HTTPException, Path

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import (
    AnchorRole,
    GeocodeConfidence,
    MembershipStatus,
    TRAVEL_ROLES,
    TripMemberRole,
)
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
from .services.hydrate import attach_consensus
from .services.places import geocode_trip_destination, place_matches_trip_scope


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


def _validate_anchor_dates(trip: dict[str, Any], row: dict[str, Any]) -> None:
    """Reject anchor dates that fall outside the trip's dates, or a stay whose
    check-out precedes its check-in.

    Lenient when either trip bound is unset. Dates are ISO 'YYYY-MM-DD' strings,
    so lexical comparison is chronological.
    """
    start, end = trip.get("start_date"), trip.get("end_date")

    def in_trip(d: str | None, label: str) -> None:
        if d and ((start and d < start) or (end and d > end)):
            raise HTTPException(
                status_code=400,
                detail=f"{label} must fall within the trip's dates",
            )

    in_trip(row.get("anchor_date"), "Arrival/departure/travel day")
    in_trip(row.get("stay_date"), "Check-in day")
    in_trip(row.get("stay_end_date"), "Check-out day")
    stay, stay_end = row.get("stay_date"), row.get("stay_end_date")
    if stay and stay_end and stay_end < stay:
        raise HTTPException(
            status_code=400, detail="Check-out can't be before check-in")


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
            # Backfill (incl. the post-005 dest_* re-arm): infer a legacy trip's
            # scope from its destination since it predates the scope picker.
            await geocode_trip_destination(sb, rows[0], infer_scope=True)


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
    """Trips the current user owns plus trips shared with them (accepted only),
    newest first, with scrap counts and the caller's role on each."""
    sb = get_supabase()
    # One RPC round-trip (owned + shared trips, roles, owner names, counts).
    rows = (
        sb.rpc("travelscrapbook_trips_list", {"p_viewer": user.user_id}).execute()
    ).data or []
    pending_geocode = [
        r["id"] for r in rows
        if r.get("destination") and not r.get("destination_geocoded_at")
    ]
    if pending_geocode:
        background_tasks.add_task(_backfill_trip_geocodes, pending_geocode)
    return TripListResponse(trips=[TripSummaryResponse(**r) for r in rows])


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
    if body.scope_level is not None:
        row["scope_level"] = body.scope_level
    created = sb.table("travelscrapbook_trips").insert(row).execute()
    trip = created.data[0]
    if body.destination:
        # Sync, like anchors — one Nominatim call so staging auto-match works
        # for scraps captured right after trip creation. Infer the scope level
        # from the destination only when the user didn't pick one.
        trip = await geocode_trip_destination(
            sb, trip, infer_scope=body.scope_level is None)
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
    """Trip with its anchors, scraps (approved and staged split out), member
    roster, and the viewer's wishlist candidates — everything the trip view
    needs, fetched in ONE DB round-trip (travelscrapbook_trip_bundle).
    Readable by the owner and any member; the response carries the caller's
    role for gating write actions."""
    sb = get_supabase()
    bundle = (
        sb.rpc(
            "travelscrapbook_trip_bundle",
            {"p_trip_id": trip_id, "p_viewer": user.user_id},
        ).execute()
    ).data
    if not bundle:
        raise HTTPException(status_code=404, detail="Trip not found")
    trip = bundle["trip"]
    scraps = attach_consensus(bundle["scraps"])
    # Scope filtering is pure math over fields the bundle already carries.
    candidates = [
        s for s in bundle["candidates"]
        if place_matches_trip_scope(
            trip,
            lat=s.get("lat"), lng=s.get("lng"),
            city=s.get("place_city"), region=s.get("place_region"),
            country=s.get("place_country"),
        )
    ]
    return TripResponse(
        **trip,
        role=TripMemberRole(bundle["role"]),
        owner_user_id=trip["user_id"],
        owner_display_name=bundle["owner_display_name"],
        anchors=bundle["anchors"],
        scraps=[ScrapResponse(**s) for s in scraps if s["status"] == MembershipStatus.APPROVED],
        staged_scraps=[ScrapResponse(**s) for s in scraps if s["status"] == MembershipStatus.STAGED],
        members=bundle["members"],
        candidates=[ScrapResponse(**s) for s in candidates],
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
    re-geocoded synchronously. Owner only."""
    sb = get_supabase()
    existing, _ = get_accessible_trip(sb, trip_id, user.user_id, need_owner=True)
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
    """Delete a trip; scraps, anchors, members, and vibes cascade. Owner only."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_owner=True)
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
    """Add a checkpoint (start/end/stay/travel anchor). start and end are
    unique per trip; a trip can hold any number of stay and travel anchors.

    Normal anchors geocode their query synchronously. An end anchor with
    ``same_as_start`` copies the start anchor's place + type instead (arrival and
    departure are often the same spot), skipping the geocode entirely — but NOT
    its date: departure day ≠ arrival day, so the request's own
    anchor_date/anchor_time still apply.

    Collaborators may edit the shared route, so this needs write access.
    """
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id, need_write=True)

    is_travel = body.role in TRAVEL_ROLES
    # Timeline marker fields: anchor_date/time + type on the travel roles
    # (start/end/travel); stay dates only on lodging.
    marker_fields = {
        "anchor_date": body.anchor_date.isoformat() if is_travel and body.anchor_date else None,
        "anchor_time": body.anchor_time.isoformat() if is_travel and body.anchor_time else None,
        "stay_date": (
            body.stay_date.isoformat()
            if body.role == AnchorRole.STAY and body.stay_date else None
        ),
        "stay_end_date": (
            body.stay_end_date.isoformat()
            if body.role == AnchorRole.STAY and body.stay_end_date else None
        ),
    }

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
            **marker_fields,
        }
    else:
        row = {
            "trip_id": trip_id,
            "role": body.role,
            "label": body.label,
            "query": body.query,
            **(await _geocode_anchor(body.query)),
            "type": body.type if is_travel else None,
            **marker_fields,
        }
    _validate_anchor_dates(trip, row)

    try:
        created = sb.table("travelscrapbook_anchors").insert(row).execute()
    except Exception as exc:
        # Partial unique index: one start + one end per trip.
        raise HTTPException(
            status_code=409,
            detail=f"Trip already has a '{body.role}' anchor",
        ) from exc
    return AnchorResponse(**created.data[0])


def _get_writable_anchor(
    sb, anchor_id: str, user_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fetch (anchor, trip) the caller may edit — the owner or a collaborator
    on its trip (anchors are shared route state, so viewers are refused). The
    trip row rides along so callers don't re-run the access lookup."""
    rows = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("id", anchor_id)
        .execute()
    )
    if not rows.data:
        raise HTTPException(status_code=404, detail="Anchor not found")
    row = rows.data[0]
    trip, _ = get_accessible_trip(sb, row["trip_id"], user_id, need_write=True)
    return row, trip


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
    """Edit label/query/dates; a changed query is re-geocoded synchronously."""
    sb = get_supabase()
    existing, trip = _get_writable_anchor(sb, anchor_id, user.user_id)
    update = {
        k: (v.isoformat() if hasattr(v, "isoformat") else v)
        for k, v in body.model_dump(exclude_unset=True).items()
    }
    if any(k in update for k in ("anchor_date", "stay_date", "stay_end_date")):
        _validate_anchor_dates(trip, {**existing, **update})
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
    _get_writable_anchor(sb, anchor_id, user.user_id)  # (anchor, trip) unused
    sb.table("travelscrapbook_anchors").delete().eq("id", anchor_id).execute()
    return MessageResponse(message="Anchor deleted")
