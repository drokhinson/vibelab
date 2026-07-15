"""Trip exports: Google Maps directions links and My Maps CSV."""

from fastapi import Depends, Path, Response

from db import get_supabase

from . import router
from .constants import AnchorRole, ScrapStatus
from .dependencies import CurrentUser, get_current_user
from .models import MapsLeg, MapsLinksResponse
from .services.exports import Stop, build_csv, build_dir_links
from .trip_routes import get_owned_trip


def _ordered_stops(sb, trip_id: str) -> list[Stop]:
    """Geocoded scraps in route order (falling back to created order),
    bracketed by the start/end anchors when they exist."""
    scraps = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("trip_id", trip_id)
        .eq("status", ScrapStatus.READY)
        .execute()
    ).data or []
    routable = [s for s in scraps if s["lat"] is not None and s["lng"] is not None]
    routable.sort(
        key=lambda s: (s["route_position"] is None, s["route_position"], s["created_at"])
    )

    anchors = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .execute()
    ).data or []

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
        Stop(
            label=s["place_name"] or s["og_title"] or s["source_domain"] or "Stop",
            lat=s["lat"],
            lng=s["lng"],
        )
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
    user: CurrentUser = Depends(get_current_user),
) -> MapsLinksResponse:
    """Multi-stop google.com/maps/dir/ URLs for the trip route, split into
    ~10-stop legs that overlap at the seams."""
    sb = get_supabase()
    get_owned_trip(sb, trip_id, user.user_id)
    legs = build_dir_links(_ordered_stops(sb, trip_id))
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
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    """CSV download (name, category, address, lat, lng, notes, url) that
    imports directly into a Google My Maps layer."""
    sb = get_supabase()
    trip = get_owned_trip(sb, trip_id, user.user_id)
    scraps = (
        sb.table("travelscrapbook_scraps")
        .select("*")
        .eq("trip_id", trip_id)
        .eq("status", ScrapStatus.READY)
        .execute()
    ).data or []
    scraps.sort(
        key=lambda s: (s["route_position"] is None, s["route_position"], s["created_at"])
    )
    rows = [
        {
            "name": s["place_name"] or s["og_title"] or s["source_url"],
            "category": s["category"],
            "address": s["geocode_display_name"] or "",
            "latitude": s["lat"] if s["lat"] is not None else "",
            "longitude": s["lng"] if s["lng"] is not None else "",
            "notes": s["notes"] or "",
            "url": s["source_url"],
        }
        for s in scraps
    ]
    filename = "".join(c if c.isalnum() or c in "-_ " else "" for c in trip["name"]).strip() or "trip"
    return Response(
        content=build_csv(rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
    )
