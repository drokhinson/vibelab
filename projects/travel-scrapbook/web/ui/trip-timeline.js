// ui/trip-timeline.js — render functions for the trip's day-by-day timeline.
// The timeline is bookended by the trip's endpoints: Arrival on top and
// Departure at the bottom (ghost "+ Arrival"/"+ Departure" buttons until each
// is set, then the anchor with an edit affordance). Day cards sit between,
// interleaving stay markers with plans — user-scheduled plans render solid;
// unscheduled plans auto-place into their SUGGESTED day as dashed rows until
// the user pins or moves them. Plans with no suggestion collect in "Anytime".
// Render-only; trip-view binds the [data-action=...] buttons.
'use strict';

const TIMELINE_MARKER_META = {
  arrival: { icon: 'plane-landing', label: 'Arrive' },
  checkin: { icon: 'home', label: 'Check in' },
  checkout: { icon: 'log-out', label: 'Check out' },
  departure: { icon: 'plane-takeoff', label: 'Depart' },
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

function _tlTime(t) {
  return t ? t.slice(0, 5) : null;
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
  return `
    <div class="sticker-card tl-endpoint">
      <span class="tl-endpoint__icon"><i data-lucide="${meta.icon}"></i></span>
      <div class="tl-endpoint__body">
        <span class="tl-endpoint__role">${meta.label}</span>
        <span class="tl-endpoint__name">${escapeHtml(anchor.label)}</span>
        <span class="scrap-card__sub">${escapeHtml(day)}${time ? ` · ${escapeHtml(time)}` : ''}</span>
      </div>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="edit-anchor" data-anchor-id="${escapeAttr(anchor.id)}"
                aria-label="Edit ${meta.label}" title="Edit ${meta.label}">
          <i data-lucide="pencil"></i>
        </button>` : ''}
    </div>`;
}

function _tlMarkerRow(m) {
  const meta = TIMELINE_MARKER_META[m.kind] || TIMELINE_MARKER_META.checkin;
  const time = _tlTime(m.time);
  return `
    <div class="tl-row tl-row--marker">
      <span class="tl-row__time">${time ? escapeHtml(time) : 'all day'}</span>
      <i data-lucide="${meta.icon}"></i>
      <span class="tl-row__label"><b>${meta.label}</b> · ${escapeHtml(m.label)}</span>
    </div>`;
}

// A user-scheduled plan row. Booked + timed = a concrete booking.
function _tlPlanRow(scrap, { canWrite = true } = {}) {
  const time = _tlTime(scrap.plan_time);
  const booked = scrap.rating === 'booked' && !!time;
  return `
    <div class="tl-row tl-row--plan ${booked ? 'tl-row--booked' : ''} ${scrap.visited_at ? 'is-visited' : ''}">
      <span class="tl-row__time">${time ? escapeHtml(time) : '·'}</span>
      <i data-lucide="${booked ? 'ticket-check' : 'map-pin'}"></i>
      <span class="tl-row__label">${escapeHtml(scrap.place_name || 'Saved place')}
        ${booked ? '<span class="tl-booked-badge">Booked</span>' : ''}</span>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="schedule" data-scrap-id="${escapeAttr(scrap.id)}"
                aria-label="Move ${escapeAttr(scrap.place_name || 'plan')}" title="Move to another day">
          <i data-lucide="clock"></i>
        </button>` : ''}
    </div>`;
}

// An auto-placed (suggested) plan: dashed, with a one-tap pin ("keep here")
// and the move button. Pinning writes plan_date = the suggested day.
function _tlSuggestedRow(scrap, { canWrite = true } = {}) {
  const sug = scrap.suggestion;
  return `
    <div class="tl-row tl-row--plan tl-row--suggested">
      <span class="tl-row__time">·</span>
      <i data-lucide="map-pin"></i>
      <span class="tl-row__label">${escapeHtml(scrap.place_name || 'Saved place')}
        <span class="tl-suggested-badge" title="Near ${escapeAttr(sug.marker_label)} (${formatKm(sug.distance_km)})">
          Suggested · near ${escapeHtml(sug.marker_label)}</span></span>
      ${canWrite ? `
        <button class="tl-row__btn tl-row__btn--pin" data-action="slot"
                data-scrap-id="${escapeAttr(scrap.id)}" data-date="${escapeAttr(sug.suggested_date)}"
                aria-label="Keep ${escapeAttr(scrap.place_name || 'plan')} on this day" title="Keep it here">
          <i data-lucide="pin"></i>
        </button>
        <button class="tl-row__btn" data-action="schedule" data-scrap-id="${escapeAttr(scrap.id)}"
                aria-label="Move ${escapeAttr(scrap.place_name || 'plan')}" title="Move to another day">
          <i data-lucide="clock"></i>
        </button>` : ''}
    </div>`;
}

function _tlAnytime(plans, { canWrite = true } = {}) {
  if (!plans.length) return '';
  return `
    <div class="sticker-card washi washi--lavender" style="padding-top:1.2rem;margin-top:1.1rem;">
      <h2 style="font-size:1.4rem;margin:0;">Anytime</h2>
      <p class="scrap-card__sub">Plans without a day yet — slot them in whenever fits.</p>
      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:0.7rem;">
        ${plans.map((s) => `
          <div class="tl-row tl-row--plan">
            <i data-lucide="map-pin"></i>
            <span class="tl-row__label">${escapeHtml(s.place_name || 'Saved place')}</span>
            ${canWrite ? `
              <button class="ts-btn ts-btn--ghost ts-btn--sm" data-action="schedule" data-scrap-id="${escapeAttr(s.id)}">
                <i data-lucide="calendar"></i>Pick a day
              </button>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

/**
 * @param {object} trip - Trip bundle (anchors ride on it).
 * @param {object|null} data - TimelineResponse (null = loading).
 * @param {{canWrite?: boolean}} opts
 */
function renderTripTimeline(trip, data, { canWrite = true } = {}) {
  if (!data) {
    return `<div class="sticker-card shimmer" style="height:140px;margin-top:1rem;"></div>`;
  }
  const days = data.days || [];
  const unscheduled = data.unscheduled || [];
  const dayDates = new Set(days.map((d) => d.date));
  // Auto-place suggested plans into their day; the rest go to Anytime.
  const suggestedByDay = {};
  const anytime = [];
  for (const s of unscheduled) {
    if (s.suggestion && dayDates.has(s.suggestion.suggested_date)) {
      (suggestedByDay[s.suggestion.suggested_date] ??= []).push(s);
    } else {
      anytime.push(s);
    }
  }
  Object.values(suggestedByDay).forEach((list) =>
    list.sort((a, b) => a.suggestion.distance_km - b.suggestion.distance_km));

  const dayCards = days.map((d, i) => {
    // Arrival/departure live in the bookends, not the day rows.
    const stayMarkers = d.markers.filter((m) => m.kind === 'checkin' || m.kind === 'checkout');
    const rows = [
      ...stayMarkers.map((m) => ({ html: _tlMarkerRow(m), time: m.time, order: 0 })),
      ...d.plans.map((p) => ({ html: _tlPlanRow(p, { canWrite }), time: p.plan_time, order: 1 })),
    ].sort((a, b) =>
      ((a.time == null) - (b.time == null)) ||
      String(a.time || '').localeCompare(String(b.time || '')) ||
      (a.order - b.order));
    const suggested = (suggestedByDay[d.date] || []).map((s) => _tlSuggestedRow(s, { canWrite }));
    const all = [...rows.map((r) => r.html), ...suggested];
    return `
      <div class="sticker-card tl-day" style="--i:${i};">
        <div class="tl-day__head">
          <span class="tl-day__num">Day ${d.day_number}</span>
          <span class="scrap-card__sub">${escapeHtml(_tlDay(d.date))}</span>
        </div>
        ${all.length ? `<div class="tl-day__rows">${all.join('')}</div>`
          : `<p class="scrap-card__sub" style="margin-top:0.3rem;">Free day — nothing planned yet.</p>`}
      </div>`;
  }).join('');

  const noDates = data.reason === 'no_dates';
  return `
    <div style="display:flex;flex-direction:column;gap:0.9rem;margin-top:1rem;">
      ${_tlEndpoint(trip, 'start', { canWrite })}
      ${dayCards}
      ${noDates ? `
        <p class="scrap-card__sub" style="text-align:center;">
          No days yet — give the trip dates (or date an anchor) and they build themselves.
          ${canWrite ? '<button class="ts-btn ts-btn--ghost ts-btn--sm" id="tl-edit-trip" style="margin-left:0.4rem;"><i data-lucide="pencil"></i>Add trip dates</button>' : ''}
        </p>` : ''}
      ${canWrite ? `
        <button class="tl-add-btn" data-action="add-anchor-role" data-role="stay">
          <i data-lucide="plus"></i>Add a stay
        </button>` : ''}
      ${_tlEndpoint(trip, 'end', { canWrite })}
    </div>
    ${_tlAnytime(anytime, { canWrite })}
  `;
}
