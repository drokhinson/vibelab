"""Day-by-day trip timeline: markers (anchors with dates) + scheduled plans,
plus proximity-based suggestions for where unscheduled plans could slot in.

Pure functions over already-hydrated rows — no DB or geocoding calls here.
"""

from datetime import date, timedelta
from typing import Any, Optional

from ..constants import AnchorRole, TIMELINE_SUGGEST_RADIUS_KM
from .optimizer import haversine_km


def _iso(d: Any) -> Optional[str]:
    """DB rows carry ISO strings; model objects carry date/time — accept both."""
    if d is None:
        return None
    return d.isoformat() if hasattr(d, "isoformat") else str(d)


def _markers_from_anchors(anchors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten anchors into dated timeline markers. A stay contributes a
    check-in and (when set) a check-out; start/end contribute arrival and
    departure. Undated anchors simply don't appear on the timeline."""
    markers: list[dict[str, Any]] = []

    def add(kind: str, a: dict[str, Any], day: Optional[str], time_: Optional[str]) -> None:
        if not day:
            return
        markers.append({
            "kind": kind,
            "anchor_id": a["id"],
            "label": a["label"],
            "lat": a.get("lat"),
            "lng": a.get("lng"),
            "date": day,
            "time": time_,
        })

    for a in anchors:
        role = a.get("role")
        if role == AnchorRole.START:
            add("arrival", a, _iso(a.get("anchor_date")), _iso(a.get("anchor_time")))
        elif role == AnchorRole.END:
            add("departure", a, _iso(a.get("anchor_date")), _iso(a.get("anchor_time")))
        elif role == AnchorRole.STAY:
            add("checkin", a, _iso(a.get("stay_date")), None)
            add("checkout", a, _iso(a.get("stay_end_date")), None)
    return markers


def _day_range(trip: dict[str, Any], markers: list[dict[str, Any]],
               scraps: list[dict[str, Any]]) -> list[str]:
    """The trip's days as ISO dates. Trip bounds win; otherwise span the
    min/max dated marker/plan. Empty when nothing is dated at all."""
    start, end = trip.get("start_date"), trip.get("end_date")
    if not (start and end):
        dated = [m["date"] for m in markers]
        dated += [_iso(s.get("plan_date")) for s in scraps if s.get("plan_date")]
        if not dated:
            return []
        start = start or min(dated)
        end = end or max(dated)
    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    if d1 < d0:
        return []
    return [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


def _sort_key(item: dict[str, Any], is_marker: bool) -> tuple:
    """Within a day: timed items first in time order, untimed after;
    markers before plans on equal footing."""
    t = item.get("time") if is_marker else _iso(item.get("plan_time"))
    return (t is None, t or "", 0 if is_marker else 1)


def _suggest(scrap: dict[str, Any], markers: list[dict[str, Any]],
             day_numbers: dict[str, int]) -> Optional[dict[str, Any]]:
    """Nearest located marker within the suggestion radius → 'slot this plan
    near that marker's day'. Stays suggest their check-in day."""
    if scrap.get("lat") is None or scrap.get("lng") is None:
        return None
    best = None
    for m in markers:
        if m["lat"] is None or m["lng"] is None or m["date"] not in day_numbers:
            continue
        km = haversine_km(scrap["lat"], scrap["lng"], m["lat"], m["lng"])
        if km <= TIMELINE_SUGGEST_RADIUS_KM and (best is None or km < best[0]):
            best = (km, m)
    if best is None:
        return None
    km, m = best
    return {
        "scrap_id": scrap["id"],
        "suggested_date": m["date"],
        "day_number": day_numbers[m["date"]],
        "marker_kind": m["kind"],
        "marker_label": m["label"],
        "distance_km": round(km, 1),
    }


def build_timeline(trip: dict[str, Any], anchors: list[dict[str, Any]],
                   scraps: list[dict[str, Any]]) -> dict[str, Any]:
    """Assemble the timeline payload from a trip, its anchors, and its
    hydrated APPROVED scraps.

    Returns {days, unscheduled, reason?}: each day carries its markers and
    scheduled plans in chronological order (untimed items after timed ones);
    unscheduled plans (unvisited only) carry a proximity suggestion when a
    located marker is within TIMELINE_SUGGEST_RADIUS_KM.
    """
    markers = _markers_from_anchors(anchors)
    days = _day_range(trip, markers, scraps)
    if not days:
        return {"days": [], "unscheduled": [], "reason": "no_dates"}
    day_numbers = {d: i + 1 for i, d in enumerate(days)}

    plans_by_day: dict[str, list[dict[str, Any]]] = {}
    unscheduled: list[dict[str, Any]] = []
    for s in scraps:
        plan_date = _iso(s.get("plan_date"))
        if plan_date and plan_date in day_numbers:
            plans_by_day.setdefault(plan_date, []).append(s)
        elif not s.get("visited_at"):
            # Unscheduled, not yet visited → offer a slot suggestion.
            unscheduled.append({**s, "suggestion": _suggest(s, markers, day_numbers)})

    day_payloads = []
    for d in days:
        day_markers = sorted(
            (m for m in markers if m["date"] == d), key=lambda m: _sort_key(m, True))
        day_plans = sorted(plans_by_day.get(d, []), key=lambda s: _sort_key(s, False))
        day_payloads.append({
            "date": d,
            "day_number": day_numbers[d],
            "markers": day_markers,
            "plans": day_plans,
        })
    return {"days": day_payloads, "unscheduled": unscheduled}
