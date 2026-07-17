"""Trip exports: Google Maps directions links, My Maps CSV, a Markdown
itinerary, and a KML point layer."""

from fastapi import Depends, Path, Query, Response

from db import get_supabase

from . import router
from .constants import AnchorRole, MembershipStatus
from .dependencies import CurrentUser, get_current_user
from .models import MapsLeg, MapsLinksResponse
from .services.exports import (
    Stop,
    build_csv,
    build_dir_links,
    build_kml,
    build_markdown,
)
from .access import get_accessible_trip
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps


def _safe_filename(name: str) -> str:
    """A trip name reduced to a filesystem-safe stem (empty → "trip")."""
    return "".join(c if c.isalnum() or c in "-_ " else "" for c in name).strip() or "trip"


def _trip_anchors(sb, trip_id: str) -> list[dict]:
    """All anchors for a trip (start/end/stay/travel)."""
    return (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .execute()
    ).data or []


def _ordered_scraps(sb, trip_id: str, *, include_visited: bool = False) -> list[dict]:
    """Approved scraps sorted the way every file export lays them out:
    route position first, then creation order."""
    scraps = _approved_scraps(sb, trip_id, include_visited=include_visited)
    scraps.sort(
        key=lambda s: (s["route_position"] is None, s["route_position"], s["created_at"])
    )
    return scraps


def _approved_scraps(sb, trip_id: str, *, include_visited: bool = False) -> list[dict]:
    """A trip's approved scraps, hydrated. Visited places sit out of routes
    and exports by default — you've already been there."""
    flat = membership_rows_to_scraps(
        (
            sb.table("travelscrapbook_scrap_trips")
            .select("*, travelscrapbook_scraps(*)")
            .eq("trip_id", trip_id)
            .eq("status", MembershipStatus.APPROVED)
            .execute()
        ).data or []
    )
    if not include_visited:
        flat = [s for s in flat if not s.get("visited_at")]
    return hydrate_scraps(sb, flat)


def _ordered_stops(sb, trip_id: str, *, include_visited: bool = False) -> list[Stop]:
    """Geocoded scraps in route order (falling back to created order),
    bracketed by the start/end anchors when they exist."""
    scraps = _approved_scraps(sb, trip_id, include_visited=include_visited)
    routable = [s for s in scraps if s["lat"] is not None and s["lng"] is not None]
    routable.sort(
        key=lambda s: (s["route_position"] is None, s["route_position"], s["created_at"])
    )

    anchors = _trip_anchors(sb, trip_id)

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


@router.get(
    "/trips/{trip_id}/export/maps-links",
    response_model=MapsLinksResponse,
    status_code=200,
    summary="Google Maps directions links",
)
async def export_maps_links(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    user: CurrentUser = Depends(get_current_user),
) -> MapsLinksResponse:
    """Multi-stop google.com/maps/dir/ URLs for the trip route, split into
    ~10-stop legs that overlap at the seams. Visited places are left out
    unless include_visited is set."""
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id)
    legs = build_dir_links(_ordered_stops(sb, trip_id, include_visited=include_visited))
    return MapsLinksResponse(
        legs=[MapsLeg(label=l.label, url=l.url, stop_count=l.stop_count) for l in legs]
    )


@router.get(
    "/trips/{trip_id}/export/csv",
    status_code=200,
    summary="CSV for Google My Maps",
    response_class=Response,
)
async def export_csv(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """CSV download (name, category, address, lat, lng, notes, url) that
    imports directly into a Google My Maps layer. Visited places are left
    out unless include_visited is set."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    scraps = _ordered_scraps(sb, trip_id, include_visited=include_visited)
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
        headers={"Content-Disposition": f'attachment; filename="{_safe_filename(trip["name"])}.csv"'},
    )


@router.get(
    "/trips/{trip_id}/export/markdown",
    status_code=200,
    summary="Markdown itinerary",
    response_class=Response,
)
async def export_markdown(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """A readable Markdown itinerary (trip header, start/end anchors, then each
    place with category, address, notes, and a Google Maps link). Visited
    places are left out unless include_visited is set."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    scraps = _ordered_scraps(sb, trip_id, include_visited=include_visited)
    content = build_markdown(trip, scraps, _trip_anchors(sb, trip_id))
    return Response(
        content=content,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{_safe_filename(trip["name"])}.md"'},
    )


@router.get(
    "/trips/{trip_id}/export/kml",
    status_code=200,
    summary="KML point layer for Google My Maps / Earth",
    response_class=Response,
)
async def export_kml(
    trip_id: str = Path(..., description="Trip UUID"),
    include_visited: bool = Query(False, description="Include places already marked visited"),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """A KML point layer — one named, described pin per geocoded place — that
    imports into Google My Maps and Google Earth. Visited places are left out
    unless include_visited is set."""
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id)
    scraps = _ordered_scraps(sb, trip_id, include_visited=include_visited)
    return Response(
        content=build_kml(trip["name"], scraps),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f'attachment; filename="{_safe_filename(trip["name"])}.kml"'},
    )
