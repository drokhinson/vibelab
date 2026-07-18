// domain/route-plan.js — client-side, WEB-ONLY itinerary builder.
//
// Layers on top of buildTimeline (domain/timeline.js): it takes that day
// scaffold and places every routable plan onto a day using the same
// nearest-neighbor/2-opt clustering the backend route optimizer uses
// (services/route_planner.py), then computes the distance + estimated
// drive/walk time (domain/geo.js) between consecutive stops. Each day's first
// todo also gets a leg from where the day starts (its stay/travel checkpoint, or
// the Arrival anchor / prior day's last stop), and the trip closes with a leg
// from the last stop to the Departure anchor (`endLeg`). The timeline IS the
// route — there is no separate Route panel any more.
//
// It deliberately DIVERGES from services/route_planner.py in one way, and this
// divergence is the whole "anchoring" feature: auto-placement here is EPHEMERAL
// (never persisted to plan_date) and it flows AROUND user-anchored plans,
// counting them against each day's capacity when spreading. The backend planner
// ignores anchored plans while spreading and writes plan_date to the DB. This
// module has no backend twin — timeline.py stays the canonical timeline math
// (mirrored in timeline.js); keep the anchoring behaviour HERE, web-side only.
'use strict';

(function () {
  const CLUSTER_ROLES = new Set(['stay', 'travel']); // route_planner._CLUSTER_ROLES

  const located = (o) => o && o.lat != null && o.lng != null;
  const completed = (s) => !!(s.visited_at || s.skipped_at);
  const placementOf = (s) => (s.plan_date ? 'anchored' : 'auto');
  const pointOf = (o) => ({ id: o.id, label: o.label || o.place_name || 'Stop', lat: o.lat, lng: o.lng });
  const cmpId = (a, b) => String(a).localeCompare(String(b));

  // ---- spine (port of route_planner.build_spine + _clamp_window) ----
  const effDate = (a) => (a.role === 'stay' ? (a.stay_date || null) : (a.anchor_date || null));

  function buildSpine(anchors) {
    const cps = (anchors || [])
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => CLUSTER_ROLES.has(a.role) && located(a));
    cps.sort((x, y) => {
      const ex = effDate(x.a);
      const ey = effDate(y.a);
      if ((ex == null) !== (ey == null)) return ex == null ? 1 : -1;
      return (ex || '').localeCompare(ey || '') || (x.i - y.i);
    });
    return cps.map(({ a }) => {
      let winStart;
      let winEnd;
      if (a.role === 'stay') { winStart = a.stay_date || null; winEnd = a.stay_end_date || winStart; }
      else { winStart = a.anchor_date || null; winEnd = winStart; }
      return { label: a.label, lat: a.lat, lng: a.lng, point: pointOf(a), winStart, winEnd };
    });
  }

  const clampWindow = (cp, tripDays) => {
    if (!cp.winStart) return [];
    const lo = cp.winStart;
    const hi = cp.winEnd || cp.winStart;
    return tripDays.filter((d) => lo <= d && d <= hi);
  };

  // Run the optimizer over a list of scraps seeded from `startPoint`, strip the
  // seed anchor, and return the scraps in route order.
  function orderScraps(list, startPoint, endPoint) {
    if (!list.length) return [];
    const res = window.Geo.optimize(list.map(pointOf), startPoint || null, endPoint || null);
    const map = new Map(list.map((s) => [s.id, s]));
    return res.ordered.map((p) => map.get(p.id)).filter(Boolean);
  }

  // Order one day's rows: unfinished before finished; timed rows chronological;
  // untimed located rows in optimizer order (seeded from the last timed stop, or
  // the day's origin); unlocated rows last. Returns row objects {scrap,placement,leg}.
  function orderDayRows(anchoredPlans, autos, originPoint) {
    const all = [...anchoredPlans, ...autos];
    const unfinished = all.filter((s) => !completed(s));
    const finished = all.filter(completed).sort((a, b) => cmpId(a.id, b.id));

    const timed = unfinished.filter((s) => s.plan_time)
      .sort((a, b) => String(a.plan_time).localeCompare(String(b.plan_time)) || cmpId(a.id, b.id));
    const untimed = unfinished.filter((s) => !s.plan_time);

    const lastTimedLocated = [...timed].reverse().find(located);
    const seed = lastTimedLocated ? pointOf(lastTimedLocated) : originPoint;

    const untimedLocated = untimed.filter(located);
    const untimedUnlocated = untimed.filter((s) => !located(s)).sort((a, b) => cmpId(a.id, b.id));
    const orderedLocated = untimedLocated.length && seed
      ? orderScraps(untimedLocated, seed, null)
      : [...untimedLocated].sort((a, b) => cmpId(a.id, b.id));

    return [...timed, ...orderedLocated, ...untimedUnlocated, ...finished]
      .map((s) => ({ scrap: s, placement: placementOf(s), leg: null }));
  }

  // Walk the day's rows in order and attach each located, unfinished row's leg
  // (distance/time from the previous located stop). The first located stop's leg
  // is its hop from `originPoint` — the day's stay/travel checkpoint (or, on day
  // one, the Arrival anchor; else the prior day's last stop) — so the drive from
  // where the day starts to the first todo shows just like every other leg. That
  // same hop is the `transitionKm` counted toward the route total.
  function attachLegs(rows, originPoint) {
    let prev = null;
    let withinKm = 0;
    let transitionKm = 0;
    let stops = 0;
    for (const row of rows) {
      if (completed(row.scrap) || !located(row.scrap)) continue;
      stops += 1;
      const pt = pointOf(row.scrap);
      if (prev === null) {
        if (originPoint) {
          const leg = window.Geo.legEstimate(
            window.Geo.haversineKm(originPoint.lat, originPoint.lng, pt.lat, pt.lng));
          row.leg = leg;
          transitionKm += leg.km;
        }
      } else {
        const leg = window.Geo.legEstimate(window.Geo.haversineKm(prev.lat, prev.lng, pt.lat, pt.lng));
        row.leg = leg;
        withinKm += leg.km;
      }
      prev = pt;
    }
    return { withinKm, transitionKm, lastPoint: prev, stops };
  }

  // Quota-fill `autos` (already in route order) across `ownedDays`, counting
  // anchored plans already on each day against its capacity. Anchor-heavy days
  // fill up and push autos to later days; any leftover lands on the last day.
  function spreadAutos(autos, ownedDays, anchoredCount, autoByDay) {
    const n = ownedDays.length;
    if (!autos.length || !n) return;
    let total = autos.length;
    ownedDays.forEach((d) => { total += (anchoredCount[d] || 0); });
    const base = Math.floor(total / n);
    const extra = total % n;
    let ai = 0;
    ownedDays.forEach((d, k) => {
      const quota = base + (k < extra ? 1 : 0);
      let take = Math.min(Math.max(0, quota - (anchoredCount[d] || 0)), autos.length - ai);
      while (take-- > 0) autoByDay[d].push(autos[ai++]);
    });
    const lastD = ownedDays[n - 1];
    while (ai < autos.length) autoByDay[lastD].push(autos[ai++]);
  }

  // Undated trip (buildTimeline returns no days): no day scaffold, so every plan
  // collects in Anytime — routable ones in a single optimized path with legs +
  // total, unroutable/completed ones appended plainly.
  function buildUndated(scraps, anchors, reason) {
    const routable = scraps.filter((s) => located(s) && !completed(s)).sort((a, b) => cmpId(a.id, b.id));
    const rest = scraps.filter((s) => !(located(s) && !completed(s)));
    const startA = (anchors || []).find((a) => a.role === 'start' && located(a));
    const endA = (anchors || []).find((a) => a.role === 'end' && located(a));
    const origin = startA ? pointOf(startA) : null;

    const rows = orderScraps(routable, origin, endA ? pointOf(endA) : null)
      .map((s) => ({ scrap: s, placement: placementOf(s), leg: null }));
    const { withinKm, transitionKm, stops } = attachLegs(rows, origin);
    for (const s of rest) rows.push({ scrap: s, placement: placementOf(s), leg: null });

    // No closing leg here: the undated "Your route" list renders below the
    // Departure bookend, so a last-stop→Departure connector has no coherent home.
    // The optimizer already seeds off the end anchor for ordering.
    return {
      days: [], anytime: rows, endLeg: null,
      totalKm: withinKm + transitionKm, stopCount: stops, reason: reason || 'no_dates',
    };
  }

  /**
   * Build the unified itinerary from a trip bundle.
   * @returns {{days: Array, anytime: Array, endLeg: object|null, totalKm: number, stopCount: number, reason?: string}}
   *   days[]  = { date, day_number, markers, rows: [{ scrap, placement:'anchored'|'auto', leg|null }] }
   *   anytime = rows for plans with no map pin (or an out-of-range anchored date)
   *   endLeg  = closing hop from the last stop to the Departure anchor (null if either is missing)
   */
  function buildItinerary(trip, anchors, scraps) {
    anchors = anchors || [];
    scraps = scraps || [];
    const base = window.buildTimeline(trip, anchors, scraps);
    const days = base.days || [];
    if (!days.length) return buildUndated(scraps, anchors, base.reason);

    const tripDays = days.map((d) => d.date);
    const anchoredCount = {};
    days.forEach((d) => { anchoredCount[d.date] = (d.plans || []).length; });

    // Partition buildTimeline's unscheduled list: out-of-range anchored → Anytime
    // (still flagged anchored); geocoded & active → auto-routable; the rest
    // (no pin, or already visited/skipped) → Anytime.
    const anytime = [];
    const autoRoutable = [];
    for (const s of base.unscheduled) {
      if (s.plan_date) anytime.push({ scrap: s, placement: 'anchored', leg: null });
      else if (located(s) && !completed(s)) autoRoutable.push(s);
      else anytime.push({ scrap: s, placement: 'auto', leg: null });
    }
    autoRoutable.sort((a, b) => cmpId(a.id, b.id)); // determinism — stable input to the optimizer

    // Cluster the auto plans around the trip's stay/travel checkpoints (or, with
    // no checkpoints, one path pinned between the start/end anchors).
    const spine = buildSpine(anchors);
    const clusters = {};
    if (spine.length) {
      for (const s of autoRoutable) {
        let bi = 0;
        let bkm = Infinity;
        spine.forEach((cp, i) => {
          const km = window.Geo.haversineKm(s.lat, s.lng, cp.lat, cp.lng);
          if (km < bkm) { bkm = km; bi = i; }
        });
        (clusters[bi] ??= []).push(s);
      }
      Object.keys(clusters).forEach((i) => { clusters[i] = orderScraps(clusters[i], spine[i].point, null); });
    } else {
      const startA = anchors.find((a) => a.role === 'start' && located(a));
      const endA = anchors.find((a) => a.role === 'end' && located(a));
      clusters[0] = orderScraps(autoRoutable, startA ? pointOf(startA) : null, endA ? pointOf(endA) : null);
    }

    // Spread each cluster's autos across the days its checkpoint owns. If no
    // checkpoint owns any in-range day (or there's no spine), spread the whole
    // set across the whole trip in spine order.
    const autoByDay = {};
    tripDays.forEach((d) => { autoByDay[d] = []; });
    const clusterDays = {};
    let anyWindow = false;
    if (spine.length) {
      Object.keys(clusters).forEach((i) => {
        clusterDays[i] = clampWindow(spine[i], tripDays);
        if (clusterDays[i].length) anyWindow = true;
      });
    }
    if (!spine.length || !anyWindow) {
      const flat = [];
      Object.keys(clusters).sort((a, b) => a - b).forEach((i) => flat.push(...clusters[i]));
      spreadAutos(flat, tripDays, anchoredCount, autoByDay);
    } else {
      Object.keys(clusters).forEach((i) => {
        spreadAutos(clusters[i], clusterDays[i].length ? clusterDays[i] : tripDays, anchoredCount, autoByDay);
      });
    }

    // Order each day's rows + compute legs, threading the last located stop of
    // one day into the next as the origin (so cross-day distance is counted).
    let totalKm = 0;
    let stopCount = 0;
    const startA = anchors.find((a) => a.role === 'start' && located(a));
    let lastPoint = startA ? pointOf(startA) : (spine.length ? spine[0].point : null);

    const outDays = days.map((d) => {
      const stayCp = spine.find((cp) => cp.winStart && cp.winStart <= d.date && (cp.winEnd || cp.winStart) >= d.date);
      const origin = stayCp ? stayCp.point : lastPoint;
      const rows = orderDayRows(d.plans || [], autoByDay[d.date] || [], origin);
      const { withinKm, transitionKm, lastPoint: lp, stops } = attachLegs(rows, origin);
      totalKm += withinKm + transitionKm;
      stopCount += stops;
      if (lp) lastPoint = lp;
      return { date: d.date, day_number: d.day_number, markers: d.markers, rows };
    });

    // The trip's closing hop: from the last located stop to the Departure anchor.
    // Rendered above the Departure bookend (there's no day row to hang it on).
    const endA = anchors.find((a) => a.role === 'end' && located(a));
    let endLeg = null;
    if (endA && lastPoint) {
      endLeg = window.Geo.legEstimate(
        window.Geo.haversineKm(lastPoint.lat, lastPoint.lng, endA.lat, endA.lng));
      totalKm += endLeg.km;
    }

    return { days: outDays, anytime, endLeg, totalKm, stopCount, reason: base.reason };
  }

  window.RoutePlan = { buildItinerary };
})();
