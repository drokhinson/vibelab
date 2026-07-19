// domain/timeline.js — client-side port of the backend timeline math
// (shared-backend/routes/travel_scrapbook/services/timeline.py). The trip
// bundle already carries everything the timeline needs (checkpoints + each
// stop's plan_date/plan_time), so building it locally makes the Timeline
// tab and every schedule change instant — zero network. This port is the
// live implementation for the web app; keep it in step with the Python
// service (which still backs GET /trips/{id}/timeline for other clients).
//
// This produces the day SCAFFOLD only (days + markers + the unscheduled pile).
// Route ordering, auto-placement, and drive/walk legs layer on top in
// domain/route-plan.js — a web-only module with no backend twin. Keep THIS port
// mirroring timeline.py; put any web-only route behaviour in route-plan.js.
'use strict';

(function () {
  const SUGGEST_RADIUS_KM = 25; // TIMELINE_SUGGEST_RADIUS_KM

  function haversineKm(lat1, lng1, lat2, lng2) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  // Flatten checkpoints into dated markers: travel → its leg day, stay →
  // check-in + (when set) check-out. (026: arrival/departure bookend the
  // timeline as stops; see ui/trip-timeline.js.)
  function markersFromCheckpoints(checkpoints) {
    const markers = [];
    const add = (kind, a, day, time) => {
      if (!day) return;
      markers.push({
        kind, checkpoint_id: a.id, label: a.label,
        lat: a.lat ?? null, lng: a.lng ?? null, date: day, time: time ?? null,
      });
    };
    for (const a of checkpoints || []) {
      if (a.role === 'travel') add('travel', a, a.checkpoint_date, a.checkpoint_time);
      else if (a.role === 'stay') {
        add('checkin', a, a.stay_date, null);
        add('checkout', a, a.stay_end_date, null);
      }
    }
    return markers;
  }

  // The trip's days as ISO dates. Trip bounds win; otherwise span the
  // min/max dated marker/stop. Empty when nothing is dated at all.
  function dayRange(trip, markers, scraps) {
    let start = trip.start_date;
    let end = trip.end_date;
    if (!(start && end)) {
      const dated = [
        ...markers.map((m) => m.date),
        ...scraps.map((s) => s.plan_date).filter(Boolean),
      ];
      if (!dated.length) return [];
      start = start || dated.reduce((a, b) => (a < b ? a : b));
      end = end || dated.reduce((a, b) => (a > b ? a : b));
    }
    const d0 = new Date(start + 'T00:00:00Z');
    const d1 = new Date(end + 'T00:00:00Z');
    if (d1 < d0) return [];
    const days = [];
    for (let t = d0.getTime(); t <= d1.getTime(); t += 86400000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
  }

  // Nearest located marker within the radius → "slot this stop near that
  // marker's day". Stays suggest their check-in day.
  function suggest(scrap, markers, dayNumbers) {
    if (scrap.lat == null || scrap.lng == null) return null;
    let best = null;
    for (const m of markers) {
      if (m.lat == null || m.lng == null || !(m.date in dayNumbers)) continue;
      const km = haversineKm(scrap.lat, scrap.lng, m.lat, m.lng);
      if (km <= SUGGEST_RADIUS_KM && (best === null || km < best[0])) best = [km, m];
    }
    if (!best) return null;
    const [km, m] = best;
    return {
      scrap_id: scrap.id,
      suggested_date: m.date,
      day_number: dayNumbers[m.date],
      marker_kind: m.kind,
      marker_label: m.label,
      distance_km: Math.round(km * 10) / 10,
    };
  }

  /**
   * Assemble {days, unscheduled, reason?} from a trip bundle's own data —
   * same payload shape as GET /trips/{id}/timeline. `scraps` should be the
   * trip's APPROVED plans. Per-day row ordering is left to the renderer
   * (ui/trip-timeline.js sorts rows itself).
   */
  window.buildTimeline = function buildTimeline(trip, checkpoints, scraps) {
    const markers = markersFromCheckpoints(checkpoints);
    const days = dayRange(trip, markers, scraps);
    if (!days.length) return { days: [], unscheduled: [], reason: 'no_dates' };
    const dayNumbers = {};
    days.forEach((d, i) => { dayNumbers[d] = i + 1; });

    const stopsByDay = {};
    const unscheduled = [];
    // Every approved stop stays in the trip — a scheduled stop sits on its day,
    // an unscheduled one collects in Anytime. Completed (visited/skipped) stops
    // are kept too (greyed + sunk to the bottom by the renderer), never dropped.
    for (const s of scraps) {
      if (s.plan_date && s.plan_date in dayNumbers) {
        (stopsByDay[s.plan_date] ??= []).push(s);
      } else {
        unscheduled.push({ ...s, suggestion: suggest(s, markers, dayNumbers) });
      }
    }

    return {
      days: days.map((d) => ({
        date: d,
        day_number: dayNumbers[d],
        markers: markers.filter((m) => m.date === d),
        stops: stopsByDay[d] || [],
      })),
      unscheduled,
    };
  };
})();
