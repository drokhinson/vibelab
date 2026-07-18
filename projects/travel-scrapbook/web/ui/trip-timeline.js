// ui/trip-timeline.js — render functions for the trip's timeline.
// The timeline IS the route: every geocoded plan appears where the route
// suggestion places it (domain/route-plan.js), with the distance + estimated
// drive/walk time shown between consecutive stops. Plans the user hand-moves get
// a saved date and an anchor (pin) marker; the rest float, auto-placed (sparkles)
// and re-flow whenever the trip changes. A summary line up top gives the whole
// route's rough distance.
//
// The timeline is bookended by the trip's endpoints: Arrival on top and
// Departure at the bottom (ghost "+ Arrival"/"+ Departure" until each is set).
// Between them sits the "middle":
//   • Dated trip → day cards (stay/travel markers first, chronological, then
//     plan rows interleaved with leg connectors — including a leg from the day's
//     start into its first todo). Only ONE affordance is ever suggested here: a
//     lodging tip, and only when a day has no stay covering it.
//   • Undated trip → the whole route in best order renders inline in the middle
//     (no day cards, no separate "route" card, no date prompts).
// Each checkpoint marker carries an edit pencil. A closing leg connector (the
// last stop → Departure) renders just above the Departure bookend.
//
// Every plan row is gesture-driven (see widgets/timeline-gestures.js):
//   • the leading checkbox cycles the outcome — clear → Visited → Skipped;
//   • tapping the title opens the plan popup (notes + day/time);
//   • swipe RIGHT anchors it to a day (day picker), swipe LEFT un-anchors it;
//   • press-and-hold the right-hand grip picks the card up to drop on any day.
// Row rendering lives in ui/timeline-row.js. Render-only; trip-view binds the
// buttons + wires TimelineGestures.
'use strict';

// "City, Country" for a checkpoint, from its resolved location fields (empty
// when the anchor has neither).
function _tlPlace(o) {
  return [o && o.city, o && o.country].filter(Boolean).join(', ');
}

const TIMELINE_MARKER_META = {
  arrival: { icon: 'plane-landing', label: 'Arrive' },
  checkin: { icon: 'home', label: 'Check in' },
  checkout: { icon: 'log-out', label: 'Check out' },
  departure: { icon: 'plane-takeoff', label: 'Depart' },
  travel: { icon: 'plane', label: 'Travel' },
};

const TL_ENDPOINT_META = {
  start: { icon: 'plane-landing', label: 'Arrival' },
  end: { icon: 'plane-takeoff', label: 'Departure' },
};

function _tlDay(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

// Arrival / Departure bookend: a ghost add button until the anchor exists,
// then the anchor card with its date and an edit pencil.
function _tlEndpoint(trip, role, { canWrite = true } = {}) {
  const meta = TL_ENDPOINT_META[role];
  const anchor = (trip.anchors || []).find((a) => a.role === role);
  if (!anchor) {
    if (!canWrite) return '';
    return `
      <button class="tl-add-btn" data-action="add-anchor-role" data-role="${role}">
        <i data-lucide="plus"></i>${meta.label}
      </button>`;
  }
  const day = anchor.anchor_date ? _tlDay(anchor.anchor_date) : 'no date yet';
  const time = _tlTime(anchor.anchor_time);
  const place = _tlPlace(anchor);
  return `
    <div class="sticker-card tl-endpoint">
      <span class="tl-endpoint__icon"><i data-lucide="${meta.icon}"></i></span>
      <div class="tl-endpoint__body">
        <span class="tl-endpoint__role">${meta.label}</span>
        <span class="tl-endpoint__name">${escapeHtml(anchor.label)}</span>
        <span class="scrap-card__sub">${escapeHtml(day)}${time ? ` · ${escapeHtml(time)}` : ''}${place ? ` · ${escapeHtml(place)}` : ''}</span>
      </div>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="edit-anchor" data-anchor-id="${escapeAttr(anchor.id)}"
                aria-label="Edit ${meta.label}" title="Edit ${meta.label}">
          <i data-lucide="pencil"></i>
        </button>` : ''}
    </div>`;
}

function _tlMarkerRow(m, { canWrite = true } = {}) {
  const meta = TIMELINE_MARKER_META[m.kind] || TIMELINE_MARKER_META.checkin;
  const time = _tlTime(m.time);
  const place = _tlPlace(m);
  return `
    <div class="tl-row tl-row--marker">
      <span class="tl-row__time">${time ? escapeHtml(time) : 'all day'}</span>
      <i data-lucide="${meta.icon}"></i>
      <span class="tl-row__label"><b>${meta.label}</b> · ${escapeHtml(m.label)}${place ? ` · ${escapeHtml(place)}` : ''}</span>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="edit-anchor" data-anchor-id="${escapeAttr(m.anchor_id)}"
                aria-label="Edit ${escapeAttr(m.label)}" title="Edit checkpoint">
          <i data-lucide="pencil"></i>
        </button>` : ''}
    </div>`;
}

function _tlNextDay(iso) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + 86400000)
    .toISOString().slice(0, 10);
}

// The one thing the timeline ever suggests adding: lodging, and only when the
// trip has dates AND some day isn't covered by a stay. Prefills the checkpoint
// editor (stay) with the first uncovered stretch. Renders nothing when every
// night has a place to stay. `uncoveredDays` come pre-sorted from RoutePlan.
function _tlLodgingTip(uncoveredDays, { canWrite = true } = {}) {
  if (!canWrite || !uncoveredDays.length) return '';
  // Extend the first contiguous run of uncovered days → the stay we prefill.
  let end = uncoveredDays[0];
  for (const d of uncoveredDays.slice(1)) {
    if (d === _tlNextDay(end)) end = d; else break;
  }
  const label = uncoveredDays.length === 1
    ? `${_tlDay(uncoveredDays[0])} has no place to stay yet`
    : `${uncoveredDays.length} nights have no place to stay yet`;
  return `
    <button class="tl-add-btn" data-action="add-checkpoint-gap"
            data-start="${escapeAttr(uncoveredDays[0])}" data-end="${escapeAttr(end)}">
      <i data-lucide="home"></i>${escapeHtml(label)} — add lodging
    </button>`;
}

/**
 * @param {object} trip - Trip bundle (anchors ride on it).
 * @param {object|null} itinerary - RoutePlan.buildItinerary output (null = loading).
 * @param {{canWrite?: boolean}} opts
 */
function renderTripTimeline(trip, itinerary, { canWrite = true } = {}) {
  if (!itinerary) {
    return `<div class="sticker-card shimmer" style="height:140px;margin-top:1rem;"></div>`;
  }
  const days = itinerary.days || [];
  const anytime = itinerary.anytime || [];
  const noDates = itinerary.reason === 'no_dates';

  // A one-stop trip still gets the banner (just no distance — a single point has
  // no route); the Route ≈ Xkm span only appears once there are ≥2 located stops
  // to measure between.
  const summary = itinerary.stopCount >= 1 ? `
    <p class="tl-route-summary"><i data-lucide="route"></i>
      <span>${itinerary.stopCount >= 2 ? `Route ≈ ${escapeHtml(formatKm(itinerary.totalKm))} · ` : ''}${itinerary.stopCount} stop${itinerary.stopCount === 1 ? '' : 's'} · times are estimates</span>
    </p>` : '';

  // One row = its leg connector (if any) + the plan row.
  const rowsHtml = (rows) => rows.map((r) =>
    `${_tlLegRow(r.leg)}${_tlPlanRow(r.scrap, { canWrite, placement: r.placement })}`).join('');

  const dayCards = days.map((d, i) => {
    // Arrival/departure live in the bookends, not the day rows; stays and
    // mid-trip travel legs render inside their day, chronological. Plan rows then
    // follow in route order, each preceded by its leg connector.
    const markerRows = d.markers
      .filter((m) => m.kind !== 'arrival' && m.kind !== 'departure')
      .slice()
      .sort((a, b) =>
        ((a.time == null) - (b.time == null)) ||
        String(a.time || '').localeCompare(String(b.time || '')))
      .map((m) => _tlMarkerRow(m, { canWrite }));
    const planRows = d.rows.map((r) =>
      `${_tlLegRow(r.leg)}${_tlPlanRow(r.scrap, { canWrite, placement: r.placement })}`);
    const all = [...markerRows, ...planRows];
    return `
      <div class="sticker-card tl-day" data-day-date="${escapeAttr(d.date)}" data-day-number="${d.day_number}" style="--i:${i};">
        <div class="tl-day__head">
          <span class="tl-day__num">Day ${d.day_number}</span>
          <span class="scrap-card__sub">${escapeHtml(_tlDay(d.date))}</span>
        </div>
        ${all.length ? `<div class="tl-day__rows">${all.join('')}</div>`
          : `<p class="scrap-card__sub" style="margin-top:0.3rem;">Free day — nothing planned yet.</p>`}
      </div>`;
  }).join('');

  // The middle of the timeline. Undated trip → the whole route in best order
  // renders inline here (no day cards, no separate "route" card). Dated trip →
  // day cards, followed by any leftover rows the route couldn't place (plans
  // with neither a date nor a map pin — bare names, no heading).
  const undatedRows = (noDates && anytime.length)
    ? `<div class="tl-day__rows">${rowsHtml(anytime)}</div>` : '';
  const orphanRows = (!noDates && anytime.length)
    ? `<div class="tl-day__rows">${rowsHtml(anytime)}</div>` : '';

  return `
    <div style="display:flex;flex-direction:column;gap:0.9rem;margin-top:1rem;">
      ${summary}
      ${_tlEndpoint(trip, 'start', { canWrite })}
      ${noDates ? undatedRows : dayCards}
      ${orphanRows}
      ${noDates ? '' : _tlLodgingTip(itinerary.uncoveredDays || [], { canWrite })}
      ${itinerary.endLeg ? _tlLegRow(itinerary.endLeg) : ''}
      ${_tlEndpoint(trip, 'end', { canWrite })}
    </div>
  `;
}
