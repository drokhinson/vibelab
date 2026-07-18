"""Trip exports: Google Maps directions links, My Maps CSV, a Markdown
itinerary, and a KML point layer."""

from fastapi import Body, Depends, Path, Query, Response

from db import get_supabase

from . import router
from .constants import AnchorRole, MembershipStatus
from .dependencies import CurrentUser, get_current_user
from .models import ExportRequest, MapsLeg, MapsLinksResponse
from .services.exports import (
    Stop,
    build_csv,
    build_dir_links,
    build_kml,
    build_markdown,
)
from .access import get_accessible_trip
from .services.checkpoints import load_trip_anchors
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps


DATE_RE = r"^\d{4}-\d{2}-\d{2}$"


def _safe_filename(name: str, date: str | None = None) -> str:
    """A trip name reduced to a filesystem-safe stem (empty → "trip"),
    suffixed with the ISO date when a single day is exported."""
    stem = "".join(c if c.isalnum() or c in "-_ " else "" for c in name).strip() or "trip"
    return f"{stem} - {date}" if date else stem


def _pretty_date(date: str) -> str:
    """ISO date → a readable heading like "Mon, Aug 4 2026" (raw ISO on
    parse failure, so a malformed value never breaks the export)."""
    from datetime import date as _date

    try:
        return _date.fromisoformat(date).strftime("%a, %b %-d %Y")
    except (ValueError, TypeError):
        return date


def _trip_anchors(sb, trip_id: str) -> list[dict]:
    """All checkpoints for a trip (start/end/stay/travel), synthesized from
    role-bearing memberships in the legacy anchor shape (020)."""
    return load_trip_anchors(sb, trip_id)


def _anchor_dates(anchor: dict) -> set[str]:
    """The ISO dates an anchor touches: start/end/travel → anchor_date; a stay
    → its check-in and check-out. Used to keep only a day's checkpoints on a
    single-day markdown sheet."""
    dates = {
        str(anchor.get(k) or "")[:10]
        for k in ("anchor_date", "stay_date", "stay_end_date")
    }
    return {d for d in dates if d}


def _ordered_scraps(
    sb, trip_id: str, *, include_visited: bool = False, date: str | None = None
) -> list[dict]:
    """Approved scraps in export order. A whole-trip export lays them out in
    route order (then creation order); a single-day export (`date` set) reads
    as a time-ordered itinerary."""
    scraps = _approved_scraps(sb, trip_id, include_visited=include_visited, date=date)
    if date:
        scraps.sort(
            key=lambda s: (s["plan_time"] is None, s["plan_time"] or "", s["created_at"])
        )
    else:
        scraps.sort(
            key=lambda s: (s["route_position"] is None, s["route_position"], s["created_at"])
        )
    return scraps


def _approved_scraps(
    sb, trip_id: str, *, include_visited: bool = False, date: str | None = None
) -> list[dict]:
    """A trip's approved scraps, hydrated. Visited places sit out of routes
    and exports by default — you've already been there. When `date` is set,
    only plans scheduled to that day (`plan_date`) are kept."""
    flat = membership_rows_to_scraps(
        (
            sb.table("travelscrapbook_scrap_trips")
            .select("*, travelscrapbook_scraps(*)")
            .eq("trip_id", trip_id)
            .eq("status", MembershipStatus.APPROVED)
            .is_("role", "null")   # plans only; checkpoints bracket via anchors (020)
            .execute()
        ).data or []
    )
    if not include_visited:
        flat = [s for s in flat if not s.get("visited_at")]
    if date:
        flat = [s for s in flat if str(s.get("plan_date") or "")[:10] == date]
    return hydrate_scraps(sb, flat)


def _scraps_from_plan(
    sb, trip_id: str, plan: list, *, include_visited: bool = False, date: str | None = None
) -> list[dict]:
    """Approved scraps ordered by the CLIENT's timeline itinerary. `plan` is an
    ordered list of ExportPlanItem — the source of truth for order and each
    plan's day, so auto-placed plans (no DB `plan_date`) export in the right
    place. Each scrap's `plan_date` is overridden with the payload's computed
    day; `date` narrows to that day. Only scraps that really belong to the trip
    (and pass the visited filter) survive — the client can't smuggle in others."""
    flat = membership_rows_to_scraps(
        (
            sb.table("travelscrapbook_scrap_trips")
            .select("*, travelscrapbook_scraps(*)")
            .eq("trip_id", trip_id)
            .eq("status", MembershipStatus.APPROVED)
            .is_("role", "null")
            .execute()
        ).data or []
    )
    if not include_visited:
        flat = [s for s in flat if not s.get("visited_at")]
    by_id = {s["id"]: s for s in hydrate_scraps(sb, flat)}

    out: list[dict] = []
    seen: set[str] = set()
    for item in plan:
        s = by_id.get(item.scrap_id)
        if s is None or item.scrap_id in seen:
            continue
        seen.add(item.scrap_id)
        pd = str(item.plan_date)[:10] if item.plan_date else None
        if date and pd != date:
            continue
        out.append({**s, "plan_date": pd})
    return out


def _bracket_stops(routable: list[dict], anchors: list[dict]) -> list[Stop]:
    """Ordered geocoded scraps → a Stop list bracketed by the start/end anchors
    when they exist (the directions route begins/ends at the trip's endpoints)."""
    def anchor_stop(role: str) -> Stop | None:
        for a in anchors:
            if a["role"] == role and a["lat"] is not None:
                return Stop(label=a["label"], lat=a["lat"], lng=a["lng"])
        return None

    stops: list[Stop] = []
    start = anchor_stop(AnchorRole.START)
    if start:
        stops.append(start)
    stops.extend(
        Stop(label=s["place_name"] or "Stop", lat=s["lat"], lng=s["lng"])
        for s in routable
    )
    end = anchor_stop(AnchorRole.END)
    if end:
        stops.append(end)
    return stops


def _ordered_stops(
    sb, trip_id: str, *, include_visited: bool = False, date: str | None = None
) -> list[Stop]:
    """Geocoded scraps in route order (falling back to created order),
    bracketed by the start/end anchors when they exist. `date` narrows to one
    day's scheduled plans."""
    scraps = _approved_scraps(sb, trip_id, include_visited=include_visited, date=date)
    routable = [s for s in scraps if s["lat"] is not None and s["lng"] is not None]
    routable.sort(
        key=lambda s: (s["route_position"] is None, s["route_position"], s["created_at"])
    )
    return _bracket_stops(routable, _trip_anchors(sb, trip_id))


def _export_scraps(
    sb, trip_id: str, body: ExportRequest | None, *, include_visited: bool, date: str | None
) -> tuple[list[dict], bool]:
    """The scraps a file export should contain, in order. Returns (scraps,
    from_plan): with a client `plan`, the itinerary drives order + days;
    without one, DB `route_position` / `plan_date` do (unchanged for other
    clients)."""
    if body is not None and body.plan is not None:
        return _scraps_from_plan(sb, trip_id, body.plan, include_visited=include_visited, date=date), True
    return _ordered_scraps(sb, trip_id, include_visited=include_visited, date=date), False


def _day_groups(trip: dict, scraps: list[dict]) -> list[tuple[str, list[dict]]]:
    """Group already-ordered scraps into (heading, places) day sections by their
    (client-computed) plan_date, first-seen order = chronological. Undated plans
    collect under a trailing "Anytime" section."""
    from datetime import date as _date

    def day_no(d: str) -> int | None:
        start = trip.get("start_date")
        try:
            if start and d:
                return (_date.fromisoformat(d) - _date.fromisoformat(str(start)[:10])).days + 1
        except (ValueError, TypeError):
            pass
        return None

    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for s in scraps:
        key = str(s.get("plan_date") or "")[:10]
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(s)

    out: list[tuple[str, list[dict]]] = []
    for key in (k for k in order if k):
        n = day_no(key)
        out.append((f"Day {n} — {_pretty_date(key)}" if n else _pretty_date(key), groups[key]))
    if "" in groups:
        out.append(("Anytime", groups[""]))
    return out


@router.api_route(
    "/trips/{trip_id}/export/maps-links",
    methods=["GET", "POST"],
    response_model=MapsLinksResponse,
    status_code=200,
    summary="Google Maps directions links",
)
async def export_maps_links(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    date: str | None = Query(None, pattern=DATE_RE, description="Only this day's scheduled plans (YYYY-MM-DD)"),
    body: ExportRequest | None = Body(None),
    user: CurrentUser = Depends(get_current_user),
) -> MapsLinksResponse:
    """Multi-stop google.com/maps/dir/ URLs for the trip route, split into
    ~10-stop legs that overlap at the seams. POST a `plan` to order the stops by
    the client's timeline itinerary (incl. auto-placed plans); a plain GET falls
    back to DB route order. Visited places are left out unless include_visited;
    `date` narrows to one day."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id)
    if body is not None and body.plan is not None:
        scraps = _scraps_from_plan(sb, trip_id, body.plan, include_visited=include_visited, date=date)
        routable = [s for s in scraps if s["lat"] is not None and s["lng"] is not None]
        stops = _bracket_stops(routable, _trip_anchors(sb, trip_id))
    else:
        stops = _ordered_stops(sb, trip_id, include_visited=include_visited, date=date)
    legs = build_dir_links(stops)
    return MapsLinksResponse(
        legs=[MapsLeg(label=l.label, url=l.url, stop_count=l.stop_count) for l in legs]
    )


@router.api_route(
    "/trips/{trip_id}/export/csv",
    methods=["GET", "POST"],
    status_code=200,
    summary="CSV for Google My Maps",
    response_class=Response,
)
async def export_csv(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    date: str | None = Query(None, pattern=DATE_RE, description="Only this day's scheduled plans (YYYY-MM-DD)"),
    body: ExportRequest | None = Body(None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """CSV download (name, category, address, lat, lng, notes, url) that
    imports directly into a Google My Maps layer. POST a `plan` to order rows by
    the client's timeline itinerary (incl. auto-placed plans); a plain GET falls
    back to DB order. Visited places are left out unless include_visited;
    `date` narrows to one day."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    scraps, _from_plan = _export_scraps(sb, trip_id, body, include_visited=include_visited, date=date)
    rows = [
        {
            "name": s["place_name"] or "Stop",
            "category": s["category"],
            "address": s["geocode_display_name"] or "",
            "latitude": s["lat"] if s["lat"] is not None else "",
            "longitude": s["lng"] if s["lng"] is not None else "",
            "notes": s["notes"] or "",
            # The place's primary source link (newest); maps_url covers navigation.
            "url": s["sources"][0]["url"] if s["sources"] else (s["maps_url"] or ""),
        }
        for s in scraps
    ]
    return Response(
        content=build_csv(rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{_safe_filename(trip["name"], date)}.csv"'},
    )


@router.api_route(
    "/trips/{trip_id}/export/markdown",
    methods=["GET", "POST"],
    status_code=200,
    summary="Markdown itinerary",
    response_class=Response,
)
async def export_markdown(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    date: str | None = Query(None, pattern=DATE_RE, description="Only this day's scheduled plans (YYYY-MM-DD)"),
    body: ExportRequest | None = Body(None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """A readable Markdown itinerary (trip header, start/end anchors, then each
    place with category, address, notes, and a Google Maps link). POST a `plan`
    for a whole-trip export and it's grouped into **Day N** sections in the
    client's itinerary order (auto-placed plans included); a single day (`date`)
    reads as one time-ordered sheet. Visited places are left out unless
    include_visited is set."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    scraps, from_plan = _export_scraps(sb, trip_id, body, include_visited=include_visited, date=date)
    anchors = _trip_anchors(sb, trip_id)
    if date:
        # Only that day's checkpoints make sense on a single-day sheet.
        anchors = [a for a in anchors if date in _anchor_dates(a)]
    # A whole-trip plan export groups by day; a single day (or a DB fallback) is flat.
    day_groups = _day_groups(trip, scraps) if (from_plan and not date) else None
    content = build_markdown(
        trip, scraps, anchors,
        day_label=_pretty_date(date) if date else None,
        day_groups=day_groups,
    )
    return Response(
        content=content,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{_safe_filename(trip["name"], date)}.md"'},
    )


@router.api_route(
    "/trips/{trip_id}/export/kml",
    methods=["GET", "POST"],
    status_code=200,
    summary="KML point layer for Google My Maps / Earth",
    response_class=Response,
)
async def export_kml(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    date: str | None = Query(None, pattern=DATE_RE, description="Only this day's scheduled plans (YYYY-MM-DD)"),
    body: ExportRequest | None = Body(None),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """A KML point layer — one named, described pin per geocoded place — that
    imports into Google My Maps and Google Earth. POST a `plan` to include
    auto-placed plans in the client's itinerary order; a plain GET falls back to
    DB order. Visited places are left out unless include_visited; `date` narrows
    to one day."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    scraps, _from_plan = _export_scraps(sb, trip_id, body, include_visited=include_visited, date=date)
    name = f'{trip["name"]} — {_pretty_date(date)}' if date else trip["name"]
    return Response(
        content=build_kml(name, scraps),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f'attachment; filename="{_safe_filename(trip["name"], date)}.kml"'},
    )
