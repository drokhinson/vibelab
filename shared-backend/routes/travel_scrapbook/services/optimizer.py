"""Route ordering: nearest-neighbor seed + 2-opt improvement over haversine.

Scale is tiny (a trip has dozens of scraps, not thousands), so O(n²) passes
are trivial. Endpoints can be pinned: a start anchor fixes the first stop,
an end anchor fixes the last (open path when absent).
"""

import math
from dataclasses import dataclass
from typing import Optional

MAX_TWO_OPT_PASSES = 30


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometres (same formula as plant_planner)."""
    rlat1, rlng1, rlat2, rlng2 = map(math.radians, (lat1, lng1, lat2, lng2))
    dlat = rlat2 - rlat1
    dlng = rlng2 - rlng1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


@dataclass
class Point:
    id: str
    label: str
    lat: float
    lng: float


def _path_length(order: list[int], dist: list[list[float]]) -> float:
    return sum(dist[order[i]][order[i + 1]] for i in range(len(order) - 1))


def optimize(
    points: list[Point],
    start: Optional[Point] = None,
    end: Optional[Point] = None,
) -> tuple[list[Point], list[float], float]:
    """Order `points` into a short path.

    Returns (ordered stops incl. anchors, per-leg km, total km). The start/end
    anchors, when given, are pinned as first/last stop and included in the
    returned order so the caller can render the full itinerary.
    """
    if not points:
        anchors = [p for p in (start, end) if p]
        if len(anchors) == 2:
            d = haversine_km(anchors[0].lat, anchors[0].lng, anchors[1].lat, anchors[1].lng)
            return anchors, [d], d
        return anchors, [], 0.0

    nodes: list[Point] = []
    if start:
        nodes.append(start)
    nodes.extend(points)
    if end:
        nodes.append(end)

    n = len(nodes)
    dist = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d = haversine_km(nodes[i].lat, nodes[i].lng, nodes[j].lat, nodes[j].lng)
            dist[i][j] = dist[j][i] = d

    first = 0 if start else None
    last = n - 1 if end else None

    # Nearest-neighbor seed. Walk from the pinned start (or node 0), always
    # hopping to the closest unvisited middle node; the pinned end is appended
    # after the walk.
    middle = [i for i in range(n) if i != first and i != last]
    current = first if first is not None else middle.pop(0)
    order = [current]
    remaining = set(middle) - {current}
    while remaining:
        nxt = min(remaining, key=lambda j: dist[current][j])
        order.append(nxt)
        remaining.remove(nxt)
        current = nxt
    if last is not None:
        order.append(last)

    # 2-opt: reverse segments while it shortens the path. Endpoints stay put
    # when pinned (i ranges keep index 0 / n-1 fixed appropriately).
    lo = 1 if first is not None else 0
    hi = len(order) - 2 if last is not None else len(order) - 1
    for _ in range(MAX_TWO_OPT_PASSES):
        improved = False
        for i in range(lo, hi):
            for j in range(i + 1, hi + 1):
                if i == 0 and j == len(order) - 1:
                    continue
                before = 0.0
                after = 0.0
                if i > 0:
                    before += dist[order[i - 1]][order[i]]
                    after += dist[order[i - 1]][order[j]]
                if j < len(order) - 1:
                    before += dist[order[j]][order[j + 1]]
                    after += dist[order[i]][order[j + 1]]
                if after < before - 1e-9:
                    order[i : j + 1] = reversed(order[i : j + 1])
                    improved = True
        if not improved:
            break

    ordered = [nodes[i] for i in order]
    legs = [
        dist[order[i]][order[i + 1]] for i in range(len(order) - 1)
    ]
    return ordered, legs, sum(legs)
