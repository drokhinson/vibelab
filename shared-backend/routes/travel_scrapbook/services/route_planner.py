"""Checkpoint-aware route planning.

The plain optimizer orders a flat list of stops between a pinned start and end.
That ignores a trip's shape: a multi-city itinerary has stay/travel checkpoints
in different places, and plans belong to whichever place you're actually in on a
given day. This module clusters a trip's scraps around those checkpoints, orders
each cluster geographically, and spreads the currently-unscheduled ones across
the days that checkpoint owns — so "Sort my route" builds a coherent day-by-day
plan, not just a shortest path.

Pure functions over already-hydrated rows (mirrors services/timeline.py) — no DB
calls. Reuses the nearest-neighbor/2-opt optimizer for intra-cluster ordering and
the same haversine used across the app.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Optional

from ..constants import AnchorRole
from .optimizer import Point, haversine_km, optimize


def _iso(d: Any) -> Optional[str]:
    """DB rows carry ISO strings; model objects carry date/time — accept both."""
    if d is None:
        return None
    return d.isoformat() if hasattr(d, "isoformat") else str(d)


# Stay/travel checkpoints anchor the clustering: they're the places you actually
# base yourself in. start/end are travel checkpoints (airports/stations) that
# frame the trip's endpoints but make poor cluster centers, so they're left to
# the display path and the no-checkpoint fallback, never used to group plans.
_CLUSTER_ROLES = (AnchorRole.STAY, AnchorRole.TRAVEL)


@dataclass
class Checkpoint:
    """A located stay/travel checkpoint plus the day window it owns."""
    anchor_id: str
    label: str
    lat: float
    lng: float
    point: Point
    win_start: Optional[str]   # first ISO day this checkpoint owns
    win_end: Optional[str]     # last ISO day (inclusive); == win_start for a point


def _eff_date(a: dict[str, Any]) -> Optional[str]:
    """The date a checkpoint sorts by: a stay's check-in, else the leg day."""
    if a.get("role") == AnchorRole.STAY:
        return _iso(a.get("stay_date"))
    return _iso(a.get("anchor_date"))


def build_spine(anchors: list[dict[str, Any]]) -> list[Checkpoint]:
    """Located stay/travel checkpoints, ordered by their effective date (undated
    ones sink to the end in input order). Each carries the day window it owns: a
    stay spans check-in→check-out; a travel leg owns its single day."""
    located = [
        (i, a) for i, a in enumerate(anchors)
        if a.get("role") in _CLUSTER_ROLES
        and a.get("lat") is not None and a.get("lng") is not None
    ]

    def sort_key(item: tuple[int, dict[str, Any]]) -> tuple:
        i, a = item
        eff = _eff_date(a)
        return (eff is None, eff or "", i)

    spine: list[Checkpoint] = []
    for _, a in sorted(located, key=sort_key):
        if a.get("role") == AnchorRole.STAY:
            win_start = _iso(a.get("stay_date"))
            win_end = _iso(a.get("stay_end_date")) or win_start
        else:  # travel leg: a single day
            win_start = win_end = _iso(a.get("anchor_date"))
        spine.append(Checkpoint(
            anchor_id=a["id"], label=a["label"], lat=a["lat"], lng=a["lng"],
            point=Point(id=a["id"], label=a["label"], lat=a["lat"], lng=a["lng"]),
            win_start=win_start, win_end=win_end,
        ))
    return spine


def cluster_scraps(routable: list[dict[str, Any]],
                   spine: list[Checkpoint]) -> dict[int, list[dict[str, Any]]]:
    """Assign each routable scrap to the index of its nearest checkpoint."""
    clusters: dict[int, list[dict[str, Any]]] = {}
    for s in routable:
        best_i, best_km = 0, None
        for i, cp in enumerate(spine):
            km = haversine_km(s["lat"], s["lng"], cp.lat, cp.lng)
            if best_km is None or km < best_km:
                best_i, best_km = i, km
        clusters.setdefault(best_i, []).append(s)
    return clusters


def order_clusters(clusters: dict[int, list[dict[str, Any]]],
                   spine: list[Checkpoint]) -> dict[int, list[dict[str, Any]]]:
    """Order each cluster's scraps geographically, seeded from its checkpoint.

    The checkpoint is pinned as the path's start so the walk begins at your base;
    it is then dropped from the result (it is an anchor, not a scrap)."""
    ordered: dict[int, list[dict[str, Any]]] = {}
    for i, scraps in clusters.items():
        by_id = {s["id"]: s for s in scraps}
        points = [Point(id=s["id"], label=s["place_name"] or "Stop",
                        lat=s["lat"], lng=s["lng"]) for s in scraps]
        seq, _legs, _total = optimize(points, start=spine[i].point, end=None)
        # `p.id in by_id` naturally strips the pinned checkpoint (its id is an
        # anchor id, never a scrap id).
        ordered[i] = [by_id[p.id] for p in seq if p.id in by_id]
    return ordered


def flatten_clusters(ordered: dict[int, list[dict[str, Any]]],
                     spine: list[Checkpoint]) -> list[dict[str, Any]]:
    """Concatenate clusters in spine order into the global route order."""
    out: list[dict[str, Any]] = []
    for i in range(len(spine)):
        out.extend(ordered.get(i, []))
    return out


def trip_day_range(trip: dict[str, Any]) -> list[str]:
    """The trip's days as ISO dates from start_date..end_date inclusive; [] when
    the trip is unbounded or inverted. Mirrors timeline._day_range's bounded
    branch — the timeline never schedules a plan outside these days, so neither
    do we (keeps plan_date inside the range the schedule endpoint validates)."""
    start, end = _iso(trip.get("start_date")), _iso(trip.get("end_date"))
    if not (start and end):
        return []
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    if d1 < d0:
        return []
    return [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


def _clamp_window(cp: Checkpoint, trip_days: list[str]) -> list[str]:
    """The checkpoint's owned days intersected with the trip's day list."""
    if not cp.win_start:
        return []
    lo, hi = cp.win_start, cp.win_end or cp.win_start
    return [d for d in trip_days if lo <= d <= hi]


def _spread(scraps: list[dict[str, Any]], days: list[str]) -> dict[str, str]:
    """Place scraps across days preserving order, even buckets in both
    directions. `idx * d // n` fills early days first when scraps outnumber days
    (7 scraps / 3 days → 0,0,0,1,1,2,2) and spaces them out when days outnumber
    scraps (2 scraps / 5 days → day 0, day 2)."""
    out: dict[str, str] = {}
    n, d = len(scraps), len(days)
    if n == 0 or d == 0:
        return out
    for idx, s in enumerate(scraps):
        out[s["scrap_trip_id"]] = days[(idx * d) // n]
    return out


def spread_across_days(scraps: list[dict[str, Any]],
                       days: list[str]) -> dict[str, str]:
    """Public: spread only the *unscheduled* scraps (plan_date null) across
    `days`, in the given order. Used by the no-checkpoint fallback."""
    return _spread([s for s in scraps if not s.get("plan_date")], days)


def distribute_dates(ordered: dict[int, list[dict[str, Any]]],
                     spine: list[Checkpoint],
                     trip_days: list[str]) -> dict[str, str]:
    """Map scrap_trip_id → ISO day for currently-unscheduled scraps only.

    Each cluster's unscheduled scraps spread across the days its checkpoint owns.
    Already-scheduled plans are excluded entirely — they neither move nor consume
    a day-slot. Edge cases:
      - No trip days → return {} (route order only, nothing scheduled).
      - No checkpoint owns any in-range day → spread all unscheduled across the
        whole trip in route order.
      - A single cluster whose checkpoint has no in-range window → fall back to
        the whole trip range (a coarse spread the user can hand-adjust) rather
        than leaving that cluster unscheduled while its neighbors get days.
    """
    assigned: dict[str, str] = {}
    if not trip_days:
        return assigned

    cp_days = {i: _clamp_window(spine[i], trip_days) for i in ordered}
    if not any(cp_days.values()):
        flat = [s for i in range(len(spine)) for s in ordered.get(i, [])]
        return spread_across_days(flat, trip_days)

    for i in range(len(spine)):
        scraps = ordered.get(i)
        if not scraps:
            continue
        unscheduled = [s for s in scraps if not s.get("plan_date")]
        if not unscheduled:
            continue
        days = cp_days.get(i) or trip_days   # empty window → whole trip
        assigned.update(_spread(unscheduled, days))
    return assigned
