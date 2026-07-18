// domain/geo.js — geography helpers for the client-side route planner.
// Three things, all pure and network-free:
//   • haversineKm — great-circle distance (mirrors optimizer.py's haversine_km).
//   • optimize — a nearest-neighbor seed + 2-opt path optimizer, a faithful JS
//     port of services/optimizer.py's optimize(). Deterministic: nearest-node
//     ties break to the lowest index, so the same input always yields the same
//     path (no render-to-render flicker in the timeline).
//   • legEstimate / formatLeg — the drive/walk time HEURISTIC shown between two
//     consecutive stops. There is no routing API: distance is haversine × a road
//     factor, and time is banded by distance. Always presented as an estimate.
'use strict';

(function () {
  const MAX_TWO_OPT_PASSES = 30; // matches optimizer.py

  function haversineKm(lat1, lng1, lat2, lng2) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  /**
   * Order `points` into a short path between optional pinned start/end anchors.
   * Each point is `{ id, label, lat, lng }`. Returns `{ ordered, legs, total }`
   * where `ordered` includes the anchors (callers strip them by id) and `legs`
   * are the per-hop haversine km.
   */
  function optimize(points, start = null, end = null) {
    if (!points.length) {
      const anchors = [start, end].filter(Boolean);
      if (anchors.length === 2) {
        const d = haversineKm(anchors[0].lat, anchors[0].lng, anchors[1].lat, anchors[1].lng);
        return { ordered: anchors, legs: [d], total: d };
      }
      return { ordered: anchors, legs: [], total: 0 };
    }

    const nodes = [];
    if (start) nodes.push(start);
    for (const p of points) nodes.push(p);
    if (end) nodes.push(end);

    const n = nodes.length;
    const dist = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = haversineKm(nodes[i].lat, nodes[i].lng, nodes[j].lat, nodes[j].lng);
        dist[i][j] = dist[j][i] = d;
      }
    }

    const first = start ? 0 : null;
    const last = end ? n - 1 : null;

    // Nearest-neighbor seed: walk from the pinned start (or node 0), always
    // hopping to the closest unvisited middle node; the pinned end is appended.
    const middle = [];
    for (let i = 0; i < n; i++) if (i !== first && i !== last) middle.push(i);
    let current = first != null ? first : middle.shift();
    const order = [current];
    const remaining = new Set(middle); // insertion (ascending) order → deterministic ties
    remaining.delete(current);
    while (remaining.size) {
      let best = null;
      let bestKm = Infinity;
      for (const j of remaining) {
        if (dist[current][j] < bestKm) { bestKm = dist[current][j]; best = j; }
      }
      order.push(best);
      remaining.delete(best);
      current = best;
    }
    if (last != null) order.push(last);

    // 2-opt: reverse segments while it shortens the path. Pinned endpoints stay.
    const lo = first != null ? 1 : 0;
    const hi = last != null ? order.length - 2 : order.length - 1;
    for (let pass = 0; pass < MAX_TWO_OPT_PASSES; pass++) {
      let improved = false;
      for (let i = lo; i < hi; i++) {
        for (let j = i + 1; j <= hi; j++) {
          if (i === 0 && j === order.length - 1) continue;
          let before = 0;
          let after = 0;
          if (i > 0) { before += dist[order[i - 1]][order[i]]; after += dist[order[i - 1]][order[j]]; }
          if (j < order.length - 1) { before += dist[order[j]][order[j + 1]]; after += dist[order[i]][order[j + 1]]; }
          if (after < before - 1e-9) {
            let a = i;
            let b = j;
            while (a < b) { const t = order[a]; order[a] = order[b]; order[b] = t; a++; b--; }
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    const ordered = order.map((i) => nodes[i]);
    const legs = [];
    for (let i = 0; i < order.length - 1; i++) legs.push(dist[order[i]][order[i + 1]]);
    return { ordered, legs, total: legs.reduce((a, b) => a + b, 0) };
  }

  /**
   * Heuristic travel estimate for a hop of `km` raw haversine. Applies a road
   * factor, shows a walk under ~2 km, else bands the driving speed by distance.
   * Returns `{ km, mode: 'walk'|'drive', minutes }` — km is the road distance
   * (what you actually cover), minutes is a rounded estimate.
   */
  function legEstimate(km) {
    const roadKm = km * 1.3; // great-circle → rough road distance
    if (km < 2.0) {
      const minutes = Math.max(1, Math.round((roadKm / 4.5) * 60)); // ~4.5 km/h on foot
      return { km: roadKm, mode: 'walk', minutes };
    }
    const speed = roadKm <= 10 ? 28 : roadKm <= 50 ? 45 : roadKm <= 150 ? 70 : 90; // km/h band
    return { km: roadKm, mode: 'drive', minutes: Math.round((roadKm / speed) * 60) };
  }

  // "~30 min" / "~1 h 10" — the "~" flags it as an estimate; minutes drop at :00.
  function formatDuration(minutes) {
    if (minutes < 60) return `~${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `~${h} h ${String(m).padStart(2, '0')}` : `~${h} h`;
  }

  // "2.3 km · ~30 min walk" / "18 km · ~24 min drive".
  function formatLeg(leg) {
    if (!leg) return '';
    return `${formatKm(leg.km)} · ${formatDuration(leg.minutes)} ${leg.mode}`;
  }

  window.Geo = { haversineKm, optimize, legEstimate, formatLeg };
})();
