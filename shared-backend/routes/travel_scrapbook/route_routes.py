"""Route optimization: order a trip's scraps into the shortest path."""

from fastapi import Depends, Path

from db import get_supabase

from . import router
from .constants import AnchorRole, MembershipStatus, TripVibe
from .dependencies import CurrentUser, get_current_user
from .models import RouteLeg, RouteOptimizeRequest, RouteOptimizeResponse, ScrapResponse
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps
from .access import get_accessible_trip
from .services.optimizer import Point, optimize


def _anchor_point(anchors: list[dict], role: AnchorRole) -> Point | None:
    for a in anchors:
        if a["role"] == role and a["lat"] is not None and a["lng"] is not None:
            return Point(id=a["id"], label=a["label"], lat=a["lat"], lng=a["lng"])
    return None


@router.post(
    "/trips/{trip_id}/route/optimize",
    response_model=RouteOptimizeResponse,
    status_code=200,
    summary="Optimize the trip route",
)
async def optimize_route(
    body: RouteOptimizeRequest,
    trip_id: str = Path(..., description="Trip UUID"),
    user: CurrentUser = Depends(get_current_user),
) -> RouteOptimizeResponse:
    """Order the trip's geocoded scraps into the shortest route.

    A 'start' anchor (or, failing that, a 'stay') pins the first stop; an
    'end' anchor pins the last. The resulting order is persisted on each
    scrap's route_position. Scraps without coordinates are reported back
    as skipped.
    """
    sb = get_supabase()
    get_accessible_trip(sb, trip_id, user.user_id, need_write=True)

    scraps = hydrate_scraps(
        sb,
        membership_rows_to_scraps(
            (
                sb.table("travelscrapbook_scrap_trips")
                .select("*, travelscrapbook_scraps(*)")
                .eq("trip_id", trip_id)
                .eq("status", MembershipStatus.APPROVED)
                .execute()
            ).data or []
        ),
    )
    if body.scrap_ids is not None:
        wanted = set(body.scrap_ids)
        scraps = [s for s in scraps if s["id"] in wanted]
    if body.priority_only:
        scraps = [s for s in scraps if s.get("rating") in (TripVibe.BOOKED, TripVibe.MUST_DO)]
    if not body.include_visited:
        scraps = [s for s in scraps if not s.get("visited_at")]

    routable = [s for s in scraps if s["lat"] is not None and s["lng"] is not None]
    skipped = [s["id"] for s in scraps if s["lat"] is None or s["lng"] is None]

    anchors = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .execute()
    ).data or []
    start = _anchor_point(anchors, AnchorRole.START) or _anchor_point(anchors, AnchorRole.STAY)
    end = _anchor_point(anchors, AnchorRole.END)

    points = [
        Point(id=s["id"], label=s["place_name"] or "Stop", lat=s["lat"], lng=s["lng"])
        for s in routable
    ]
    ordered, leg_km, total_km = optimize(points, start=start, end=end)

    # Persist positions (anchors excluded — position covers scraps only).
    anchor_ids = {a["id"] for a in anchors}
    position = 0
    by_id = {s["id"]: s for s in routable}
    ordered_scraps: list[ScrapResponse] = []
    for p in ordered:
        if p.id in anchor_ids:
            continue
        position += 1
        sb.table("travelscrapbook_scrap_trips").update(
            {"route_position": position}
        ).eq("id", by_id[p.id]["scrap_trip_id"]).execute()
        row = {**by_id[p.id], "route_position": position}
        ordered_scraps.append(ScrapResponse(**row))

    legs = [
        RouteLeg(
            from_label=ordered[i].label,
            to_label=ordered[i + 1].label,
            distance_km=round(leg_km[i], 2),
        )
        for i in range(len(leg_km))
    ]
    return RouteOptimizeResponse(
        ordered_scraps=ordered_scraps,
        legs=legs,
        total_km=round(total_km, 2),
        skipped_scrap_ids=skipped,
    )
