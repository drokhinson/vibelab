"""Trip CRUD, checkpoint (stay/travel) and endpoint (arrival/departure) management.

Since migration 020 a checkpoint is a place + scrap + role-bearing
travelscrapbook_scrap_trips membership (not an anchors-table row). The
/anchors endpoints keep their paths and AnchorResponse shape — the anchor id
is now the membership id, and responses are synthesized via
services/checkpoints.py. Since 026 arrival/departure are NOT checkpoints: they
are ordinary role-NULL plans flagged is_arrival/is_departure, managed through
the /trips/{id}/endpoints routes and returned as ScrapResponse.
"""

from typing import Any

from fastapi import BackgroundTasks, Depends, HTTPException, Path
from supabase import Client

from db import get_supabase

from . import router
from .access import get_accessible_trip
from .constants import (
    AnchorRole,
    Endpoint,
    MembershipStatus,
    TRAVEL_ROLES,
    TripMemberRole,
)
from .dependencies import CurrentUser, get_current_user
from .models import (
    AnchorCreateRequest,
    AnchorResponse,
    AnchorUpdateRequest,
    EndpointCreateRequest,
    EndpointUpdateRequest,
    MessageResponse,
    ScrapResponse,
    TripCreateRequest,
    TripListResponse,
    TripResponse,
    TripSummaryResponse,
    TripUpdateRequest,
)
from .services import checkpoints
from .services.hydrate import attach_consensus
from .services.places import (
    build_maps_url,
    geocode_trip_destination,
    normalize_place_name,
    place_matches_trip_scope,
    region_for_country_code,
    trip_scope_sets,
)


def _get_endpoint_membership(
    sb: Client, trip_id: str, flag: str
) -> dict[str, Any] | None:
    """A trip's arrival (flag='is_arrival') or departure (flag='is_departure')
    bookend plan membership, if set. Pre-checks the one-arrival/one-departure
    slots so a duplicate 409s BEFORE materializing an orphan scrap; the partial
    unique indexes stay the authoritative (race-proof) guard."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*")
        .eq("trip_id", trip_id)
        .eq(flag, True)
        .execute()
    )
    return rows.data[0] if rows.data else None


def _plan_membership(
    sb: Client, scrap_id: str, trip_id: str
) -> dict[str, Any] | None:
    """The existing role-NULL plan membership for (scrap, trip), if any — so
    flagging a place that's already a plan reuses that row (respecting the
    plan-uniqueness index) instead of inserting a duplicate."""
    rows = (
        sb.table("travelscrapbook_scrap_trips")
        .select("*")
        .eq("scrap_id", scrap_id)
        .eq("trip_id", trip_id)
        .is_("role", "null")
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
    # Additive-union scope: the trip's own destination PLUS the countries/regions
    # of its approved members (plans + checkpoints/anchors). Built from fields the
    # bundle already carries — no extra query. Mirrors the SQL union in
    # travelscrapbook_trip_suggestions (025).
    member_places = [
        {"country": s.get("place_country"), "region": s.get("place_region")}
        for s in bundle["scraps"] if s.get("status") == MembershipStatus.APPROVED
    ] + [
        {"country": a.get("country"), "region": a.get("region")}
        for a in bundle["anchors"]
    ]
    union_countries, union_regions = trip_scope_sets(member_places)
    # Scope filtering is pure math over fields the bundle already carries.
    candidates = [
        s for s in bundle["candidates"]
        if place_matches_trip_scope(
            trip,
            lat=s.get("lat"), lng=s.get("lng"),
            city=s.get("place_city"), region=s.get("place_region"),
            country=s.get("place_country"),
            union_countries=union_countries, union_regions=union_regions,
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


# ── Checkpoints (the /anchors API surface) ────────────────────────────────────

def _marker_dates(body: AnchorCreateRequest | AnchorUpdateRequest, role: str) -> dict[str, Any]:
    """Role-shaped date fields from a request body, ISO-serialized, in the
    legacy anchor key names _validate_anchor_dates checks."""
    is_travel = role in TRAVEL_ROLES
    return {
        "anchor_date": body.anchor_date.isoformat() if is_travel and body.anchor_date else None,
        "anchor_time": body.anchor_time.isoformat() if is_travel and body.anchor_time else None,
        "stay_date": (
            body.stay_date.isoformat()
            if role == AnchorRole.STAY and body.stay_date else None
        ),
        "stay_end_date": (
            body.stay_end_date.isoformat()
            if role == AnchorRole.STAY and body.stay_end_date else None
        ),
    }


def _membership_dates(dates: dict[str, Any], role: str) -> dict[str, Any]:
    """Legacy anchor date keys → unified membership columns: stays put their
    check-in/out on plan_date/plan_end_date; travel roles use plan_date/time."""
    if role == AnchorRole.STAY:
        return {
            "plan_date": dates.get("stay_date"),
            "plan_end_date": dates.get("stay_end_date"),
        }
    return {
        "plan_date": dates.get("anchor_date"),
        "plan_time": dates.get("anchor_time"),
    }


def _anchor_response(sb: Client, membership_id: str) -> AnchorResponse:
    row = checkpoints.get_checkpoint_membership(sb, membership_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    scrap = row["travelscrapbook_scraps"]
    place = scrap["travelscrapbook_places"]
    return AnchorResponse(**checkpoints.synthesize_anchor(row, scrap, place))


@router.post(
    "/trips/{trip_id}/anchors",
    response_model=AnchorResponse,
    status_code=201,
    summary="Add a checkpoint",
)
async def create_anchor(
    body: AnchorCreateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> AnchorResponse:
    """Add a checkpoint (stay or travel). A trip can hold any number of stays and
    travel legs. (Arrival/departure are no longer checkpoints — set them via
    POST /trips/{id}/endpoints; they're ordinary bookend plans now.)

    The checkpoint's place is materialized into the caller's saved places
    (deduped like any capture — it also appears on their Wander List / Visited
    under Stays & transport), and the trip link is a role-bearing membership.

    Collaborators may edit the shared route, so this needs write access.
    """
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id, need_write=True)

    dates = _marker_dates(body, body.role)
    _validate_anchor_dates(trip, dates)

    place, scrap = await checkpoints.materialize_checkpoint_scrap(
        sb, user.user_id,
        label=body.label,
        category=checkpoints.category_for(body.role, body.type),
        query=body.query,
        maps_url=body.maps_url,
    )

    membership = {
        "scrap_id": scrap["id"],
        "trip_id": trip_id,
        "role": body.role,
        "status": MembershipStatus.APPROVED,
        **_membership_dates(dates, body.role),
    }
    created = sb.table("travelscrapbook_scrap_trips").insert(membership).execute()
    return _anchor_response(sb, created.data[0]["id"])


def _get_writable_checkpoint(
    sb: Client, membership_id: str, user_id: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fetch (checkpoint membership with scrap+place embedded, trip) the caller
    may edit — the owner or a collaborator on its trip (checkpoints are shared
    route state, so viewers are refused)."""
    row = checkpoints.get_checkpoint_membership(sb, membership_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    trip, _ = get_accessible_trip(sb, row["trip_id"], user_id, need_write=True)
    return row, trip


@router.patch(
    "/anchors/{anchor_id}",
    response_model=AnchorResponse,
    status_code=200,
    summary="Update a checkpoint",
)
async def update_anchor(
    body: AnchorUpdateRequest,
    anchor_id: str = Path(..., description="Checkpoint (membership) UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> AnchorResponse:
    """Edit a checkpoint. Dates land on the trip membership. A LOCATION change
    (query or Maps link) re-materializes the place and REPOINTS this membership
    — the old place may back the user's Wander List, so it is never mutated to a
    different location out from under them; if the edit resolves to the SAME canonical
    place, its pin/link are refreshed in place (never wiping OSM identity).
    Label/type-only edits write through to the current place (a rename is a
    correction, not a move). Any trip writer may edit."""
    sb = get_supabase()
    existing, trip = _get_writable_checkpoint(sb, anchor_id, user.user_id)
    scrap = existing["travelscrapbook_scraps"]
    place = scrap["travelscrapbook_places"]
    role = existing["role"]
    synth_query = place.get("geocode_display_name") or place["name"]

    update = {
        k: (v.isoformat() if hasattr(v, "isoformat") else v)
        for k, v in body.model_dump(exclude_unset=True).items()
    }

    if any(k in update for k in ("anchor_date", "stay_date", "stay_end_date")):
        current = checkpoints.synthesize_anchor(existing, scrap, place)
        merged = {**{k: current.get(k) for k in
                     ("anchor_date", "stay_date", "stay_end_date")}, **update}
        _validate_anchor_dates(trip, merged)

    membership_update: dict[str, Any] = {}
    if role == AnchorRole.STAY:
        if "stay_date" in update:
            membership_update["plan_date"] = update["stay_date"]
        if "stay_end_date" in update:
            membership_update["plan_end_date"] = update["stay_end_date"]
    else:
        if "anchor_date" in update:
            membership_update["plan_date"] = update["anchor_date"]
        if "anchor_time" in update:
            membership_update["plan_time"] = update["anchor_time"]

    # Location comes only from a Maps link now — a rename (query/label change)
    # never re-resolves, so an existing pin is never moved or wiped by an edit
    # to the name. A bare-name checkpoint stays unlocated. (The URL-capture flow
    # is the only place a text location is geocoded — see resolve_checkpoint_geo.)
    location_changed = "maps_url" in update

    if location_changed:
        geo, confidence, url = await checkpoints.resolve_checkpoint_geo(
            sb,
            maps_url=update.get("maps_url"),
            query=update.get("query", synth_query),
        )
        new_label = update.get("label") or place["name"]
        category = checkpoints.category_for(
            role,
            update.get("type") or checkpoints.type_for_category(place.get("category")),
        )
        new_place, new_scrap = checkpoints.place_scrap_from_geo(
            sb, user.user_id, label=new_label, category=category,
            geo=geo, confidence=confidence, maps_url=url or None,
        )
        if new_place["id"] != place["id"]:
            # A different real-world place: repoint the membership; the old
            # place/scrap survive untouched (other checkpoints, Wander List).
            membership_update["scrap_id"] = new_scrap["id"]
        elif geo is not None:
            # Same canonical place with a fresh resolution: refresh the pin.
            # find_or_create only FILLS gaps, so overwrite explicitly — but
            # never wipe OSM identity with a resolution that lacks it.
            refresh: dict[str, Any] = {
                "lat": geo.lat, "lng": geo.lng,
                "city": geo.city, "country": geo.country,
                "country_code": geo.country_code,
                "region": region_for_country_code(sb, geo.country_code),
                "geocode_confidence": confidence,
                "geocode_display_name": geo.display_name or None,
                "updated_at": "now()",
            }
            if geo.osm_id is not None:
                refresh.update({"osm_type": geo.osm_type, "osm_id": geo.osm_id})
            if "maps_url" in update:
                refresh["maps_url"] = url
            if update.get("label"):
                # A rename riding along with the re-pin (find_or_create only
                # fills gaps, so apply it explicitly).
                refresh["name"] = update["label"]
                refresh["name_normalized"] = normalize_place_name(update["label"])
            sb.table("travelscrapbook_places").update(refresh).eq(
                "id", place["id"]
            ).execute()
    else:
        # No location change: label/type write through to the current place.
        place_update: dict[str, Any] = {}
        if update.get("label"):
            place_update["name"] = update["label"]
            place_update["name_normalized"] = normalize_place_name(update["label"])
            # Keep a generated search link in step with the rename; a
            # user-pasted Maps link is never touched.
            current_maps = place.get("maps_url") or ""
            if not current_maps or current_maps.startswith(
                "https://www.google.com/maps/search/"
            ):
                place_update["maps_url"] = build_maps_url(
                    update["label"], place.get("city"), place.get("country"))
        if update.get("type") and role != AnchorRole.STAY:
            place_update["category"] = checkpoints.category_for(role, update["type"])
        if place_update:
            place_update["updated_at"] = "now()"
            sb.table("travelscrapbook_places").update(place_update).eq(
                "id", place["id"]
            ).execute()

    if membership_update:
        sb.table("travelscrapbook_scrap_trips").update(membership_update).eq(
            "id", anchor_id
        ).execute()
    return _anchor_response(sb, anchor_id)


@router.delete(
    "/anchors/{anchor_id}",
    response_model=MessageResponse,
    status_code=200,
    summary="Delete a checkpoint",
)
async def delete_anchor(
    anchor_id: str = Path(..., description="Checkpoint (membership) UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove a checkpoint from its trip. Only the trip link is deleted — the
    place and the creator's scrap survive (on the Wander List / Visited)."""
    sb = get_supabase()
    _get_writable_checkpoint(sb, anchor_id, user.user_id)
    sb.table("travelscrapbook_scrap_trips").delete().eq("id", anchor_id).execute()
    return MessageResponse(message="Checkpoint removed from the trip")


# ── Endpoints (arrival / departure — the trip's bookend plans, 026) ───────────

def _endpoint_scrap(sb: Client, scrap_id: str, trip_id: str) -> ScrapResponse:
    """The bookend plan hydrated in the trip's context (same echo the plan
    mutations use), so the client patches it straight into scraps[]."""
    row = (
        sb.rpc("travelscrapbook_scrap_card",
               {"p_scrap_id": scrap_id, "p_trip_id": trip_id}).execute()
    ).data
    if not row:
        raise HTTPException(status_code=404, detail="Endpoint not on that trip")
    attach_consensus([row])
    return ScrapResponse(**row)


def _validate_endpoint_date(trip: dict[str, Any], date_str: str | None, label: str) -> None:
    """Reject a bookend date outside the trip's dates (lenient when unset)."""
    start, end = trip.get("start_date"), trip.get("end_date")
    if date_str and ((start and date_str < start) or (end and date_str > end)):
        raise HTTPException(
            status_code=400, detail=f"{label} must fall within the trip's dates")


def _endpoint_cols(which: Endpoint) -> tuple[str, str]:
    """(flag column, date column) for an endpoint: arrival → is_arrival/plan_date,
    departure → is_departure/plan_end_date."""
    if which == Endpoint.ARRIVAL:
        return "is_arrival", "plan_date"
    return "is_departure", "plan_end_date"


@router.post(
    "/trips/{trip_id}/endpoints",
    response_model=ScrapResponse,
    status_code=201,
    summary="Set the trip's arrival or departure",
)
async def create_endpoint(
    body: EndpointCreateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Set the trip's arrival or departure — an ordinary place that bookends the
    trip (role-NULL plan flagged is_arrival/is_departure). Its place is
    materialized into the caller's saved places (deduped like any capture). A
    departure with ``same_as_arrival`` reuses the arrival place (flags its plan
    as the departure too) — one row, both ends — but keeps its own date.

    Collaborators may edit the shared route, so this needs write access."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    flag, date_col = _endpoint_cols(body.which)
    date_str = body.day.isoformat() if body.day else None
    _validate_endpoint_date(trip, date_str, f"{str(body.which).capitalize()} day")

    # Pre-check the one-arrival/one-departure slot so a duplicate 409s BEFORE the
    # place/scrap materialize below; the partial unique index is the race guard.
    if _get_endpoint_membership(sb, trip_id, flag):
        raise HTTPException(status_code=409, detail=f"Trip already has a {body.which}")

    if body.same_as_arrival:
        if body.which != Endpoint.DEPARTURE:
            raise HTTPException(
                status_code=400, detail="Only the departure can reuse the arrival")
        arrival = _get_endpoint_membership(sb, trip_id, "is_arrival")
        if not arrival:
            raise HTTPException(status_code=400, detail="Set the arrival first")
        sb.table("travelscrapbook_scrap_trips").update(
            {"is_departure": True, "plan_end_date": date_str}
        ).eq("id", arrival["id"]).execute()
        return _endpoint_scrap(sb, arrival["scrap_id"], trip_id)

    place, scrap = await checkpoints.materialize_checkpoint_scrap(
        sb, user.user_id,
        label=body.label,
        category=checkpoints.category_for(AnchorRole.TRAVEL, body.type),
        query=body.query,
        maps_url=body.maps_url,
    )

    # Flag an existing plan for this place (respecting the plan-uniqueness index),
    # else insert a fresh bookend plan.
    existing = _plan_membership(sb, scrap["id"], trip_id)
    if existing:
        sb.table("travelscrapbook_scrap_trips").update(
            {flag: True, date_col: date_str or existing.get(date_col)}
        ).eq("id", existing["id"]).execute()
    else:
        sb.table("travelscrapbook_scrap_trips").insert(
            {"scrap_id": scrap["id"], "trip_id": trip_id,
             "status": MembershipStatus.APPROVED, flag: True, date_col: date_str}
        ).execute()
    return _endpoint_scrap(sb, scrap["id"], trip_id)


@router.patch(
    "/trips/{trip_id}/endpoints/{which}",
    response_model=ScrapResponse,
    status_code=200,
    summary="Update the trip's arrival or departure",
)
async def update_endpoint(
    body: EndpointUpdateRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    which: Endpoint = Path(..., description="arrival or departure"),
    user: CurrentUser = Depends(get_current_user),
) -> ScrapResponse:
    """Edit the trip's arrival/departure: change its date, or its location (which
    re-materializes the place and repoints this bookend — the old place survives
    on the Wander List). Editing the location of a place that bookends BOTH ends
    splits it so only this end moves. Any trip writer may edit."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    flag, date_col = _endpoint_cols(which)
    m = _get_endpoint_membership(sb, trip_id, flag)
    if m is None:
        raise HTTPException(status_code=404, detail=f"Trip has no {which}")

    fields = body.model_dump(exclude_unset=True)
    date_str = body.day.isoformat() if body.day else None
    if "day" in fields:
        _validate_endpoint_date(trip, date_str, f"{str(which).capitalize()} day")
    keep_date = date_str if "day" in fields else m.get(date_col)

    location_change = bool(body.label or body.query or body.maps_url)
    if not location_change:
        if "day" in fields:
            sb.table("travelscrapbook_scrap_trips").update(
                {date_col: date_str}).eq("id", m["id"]).execute()
        return _endpoint_scrap(sb, m["scrap_id"], trip_id)

    if not body.label or not body.query:
        raise HTTPException(
            status_code=400, detail="label and query are required to change the location")
    place, scrap = await checkpoints.materialize_checkpoint_scrap(
        sb, user.user_id,
        label=body.label,
        category=checkpoints.category_for(AnchorRole.TRAVEL, body.type),
        query=body.query,
        maps_url=body.maps_url,
    )

    shared = m.get("is_arrival") and m.get("is_departure")
    if shared:
        # This end moves to the new place; the other end stays on the old row.
        sb.table("travelscrapbook_scrap_trips").update(
            {flag: False, date_col: None}).eq("id", m["id"]).execute()
        target = _plan_membership(sb, scrap["id"], trip_id)
        if target:
            sb.table("travelscrapbook_scrap_trips").update(
                {flag: True, date_col: keep_date}).eq("id", target["id"]).execute()
        else:
            sb.table("travelscrapbook_scrap_trips").insert(
                {"scrap_id": scrap["id"], "trip_id": trip_id,
                 "status": MembershipStatus.APPROVED, flag: True, date_col: keep_date}
            ).execute()
        return _endpoint_scrap(sb, scrap["id"], trip_id)

    target = _plan_membership(sb, scrap["id"], trip_id)
    if target and target["id"] != m["id"]:
        # New place already a plan on this trip: fold the flag onto it, drop the old row.
        sb.table("travelscrapbook_scrap_trips").update(
            {flag: True, date_col: keep_date}).eq("id", target["id"]).execute()
        sb.table("travelscrapbook_scrap_trips").delete().eq("id", m["id"]).execute()
    else:
        sb.table("travelscrapbook_scrap_trips").update(
            {"scrap_id": scrap["id"], date_col: keep_date}).eq("id", m["id"]).execute()
    return _endpoint_scrap(sb, scrap["id"], trip_id)


@router.delete(
    "/trips/{trip_id}/endpoints/{which}",
    response_model=MessageResponse,
    status_code=200,
    summary="Clear the trip's arrival or departure",
)
async def delete_endpoint(
    trip_id: str = Path(..., description="Trip UUID"),
    which: Endpoint = Path(..., description="arrival or departure"),
    user: CurrentUser = Depends(get_current_user),
) -> MessageResponse:
    """Remove the trip's arrival/departure bookend. When one place is BOTH ends,
    only this end's flag is cleared (the other stays). Otherwise the bookend plan
    is removed from the trip; the place and scrap survive on the Wander List."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)
    flag, date_col = _endpoint_cols(which)
    other_flag = "is_departure" if which == Endpoint.ARRIVAL else "is_arrival"
    m = _get_endpoint_membership(sb, trip_id, flag)
    if m is None:
        raise HTTPException(status_code=404, detail=f"Trip has no {which}")

    if m.get(other_flag):
        sb.table("travelscrapbook_scrap_trips").update(
            {flag: False, date_col: None}).eq("id", m["id"]).execute()
    else:
        sb.table("travelscrapbook_scrap_trips").delete().eq("id", m["id"]).execute()
    return MessageResponse(message=f"{str(which).capitalize()} cleared")
