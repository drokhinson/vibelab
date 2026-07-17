"""Route optimization: order a trip's scraps into a coherent, checkpoint-aware
route and lay the unscheduled ones onto the timeline."""

from fastapi import Depends, Path

from db import get_supabase

from . import router
from .constants import AnchorRole, MembershipStatus, TripVibe
from .dependencies import CurrentUser, get_current_user
from .models import RouteLeg, RouteOptimizeRequest, RouteOptimizeResponse, ScrapResponse
from .services.hydrate import hydrate_scraps, membership_rows_to_scraps
from .access import get_accessible_trip
from .services.optimizer import Point, haversine_km, optimize
from .services.route_planner import (
    build_spine,
    cluster_scraps,
    distribute_dates,
    flatten_clusters,
    order_clusters,
    spread_across_days,
    trip_day_range,
)


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
    """Order the trip's geocoded scraps into a coherent route and itinerary.

    When the trip has stay/travel checkpoints, plans are clustered around the
    nearest checkpoint, each cluster is ordered geographically, and the
    currently-unscheduled plans are spread across the days that checkpoint owns —
    so the route also fills the timeline. With no such checkpoints it falls back
    to a single path pinned by the 'start' (or a 'stay') and 'end' anchors, and
    spreads unscheduled plans across the trip's days when it has any. Already-
    scheduled plans keep their day; only route_position is recomputed for them.
    Scraps without coordinates are reported back as skipped.
    """
    sb = get_supabase()
    trip, _ = get_accessible_trip(sb, trip_id, user.user_id, need_write=True)

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

    # Ordered by created_at to match the trip bundle (015 RPC) and the frontend
    # Route panel, so "first stay" resolves to the same anchor on both sides —
    # keeps the start-or-stay display leg aligned with the panel's stop list.
    anchors = (
        sb.table("travelscrapbook_anchors")
        .select("*")
        .eq("trip_id", trip_id)
        .order("created_at")
        .execute()
    ).data or []

    # Checkpoint-aware ordering + timeline placement. With located stay/travel
    # checkpoints, cluster around them and spread unscheduled plans over each
    # checkpoint's days; otherwise fall back to a single pinned start→end path
    # and (if the trip is dated) spread unscheduled plans across all its days.
    spine = build_spine(anchors)
    if spine:
        ordered_clusters = order_clusters(cluster_scraps(routable, spine), spine)
        ordered = flatten_clusters(ordered_clusters, spine)
        date_by_membership = distribute_dates(ordered_clusters, spine, trip_day_range(trip))
    else:
        start = _anchor_point(anchors, AnchorRole.START) or _anchor_point(anchors, AnchorRole.STAY)
        end = _anchor_point(anchors, AnchorRole.END)
        points = [
            Point(id=s["id"], label=s["place_name"] or "Stop", lat=s["lat"], lng=s["lng"])
            for s in routable
        ]
        seq, _legs, _total = optimize(points, start=start, end=end)
        anchor_ids = {a["id"] for a in anchors}
        by_id = {s["id"]: s for s in routable}
        ordered = [by_id[p.id] for p in seq if p.id in by_id and p.id not in anchor_ids]
        date_by_membership = spread_across_days(ordered, trip_day_range(trip))

    # Persist route order (all plans) + filled plan_date (unscheduled only) in
    # ONE statement via the bulk RPC. plan_date is written only where it was null
    # (enforced again in SQL) so re-running never disturbs a hand-scheduled plan.
    ordered_scraps: list[ScrapResponse] = []
    rows: list[dict] = []
    for position, s in enumerate(ordered, start=1):
        membership_id = s["scrap_trip_id"]
        new_date = date_by_membership.get(membership_id)
        rows.append({"id": membership_id, "pos": position, "plan_date": new_date})
        ordered_scraps.append(ScrapResponse(**{
            **s,
            "route_position": position,
            "plan_date": new_date or s.get("plan_date"),
        }))
    if rows:
        sb.rpc(
            "travelscrapbook_set_route_plan", {"p_trip_id": trip_id, "p_rows": rows}
        ).execute()

    # Display legs over the same stop chain the Route panel reconstructs:
    # [start-or-stay?] + ordered scraps + [end?]. Keeping this aligned with the
    # frontend's stop list means per-leg distances line up without the panel
    # needing to know about intermediate checkpoints.
    chain: list[Point] = []
    disp_start = _anchor_point(anchors, AnchorRole.START) or _anchor_point(anchors, AnchorRole.STAY)
    disp_end = _anchor_point(anchors, AnchorRole.END)
    if disp_start:
        chain.append(disp_start)
    chain.extend(
        Point(id=s["id"], label=s["place_name"] or "Stop", lat=s["lat"], lng=s["lng"])
        for s in ordered
    )
    if disp_end:
        chain.append(disp_end)
    legs = [
        RouteLeg(
            from_label=chain[i].label,
            to_label=chain[i + 1].label,
            distance_km=round(haversine_km(chain[i].lat, chain[i].lng,
                                           chain[i + 1].lat, chain[i + 1].lng), 2),
        )
        for i in range(len(chain) - 1)
    ]
    return RouteOptimizeResponse(
        ordered_scraps=ordered_scraps,
        legs=legs,
        total_km=round(sum(leg.distance_km for leg in legs), 2),
        skipped_scrap_ids=skipped,
    )
