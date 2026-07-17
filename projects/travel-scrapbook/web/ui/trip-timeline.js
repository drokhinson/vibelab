// ui/trip-timeline.js — render functions for the trip's day-by-day timeline.
// The timeline is bookended by the trip's endpoints: Arrival on top and
// Departure at the bottom (ghost "+ Arrival"/"+ Departure" buttons until each
// is set, then the anchor with an edit affordance). Day cards sit between:
// stay/travel markers first (chronological), then plans sorted by DESCENDING
// priority — user-scheduled plans render solid; unscheduled plans auto-place
// into their SUGGESTED day as dashed rows until the user pins or moves them.
// Plans with no suggestion collect in "Anytime".
//
// Every plan row is gesture-driven (see widgets/timeline-gestures.js):
//   • a leading checkbox cycles the outcome — clear → Visited → Skipped → clear,
//     greying + tagging the place;
//   • swipe RIGHT opens the day picker (schedule);
//   • swipe LEFT unschedules a scheduled plan (removes it from the timeline);
//   • press-and-hold picks the card up to drop on any day.
// A "+ Checkpoint" affordance (stay or travel leg) sits mid-timeline, and
// every checkpoint marker carries an edit pencil.
// Render-only; trip-view binds the buttons + wires TimelineGestures.
'use strict';

// Owner priority → sort weight (booked highest). Unrated = 0.
const TL_PRIORITY_RANK = { booked: 4, must_do: 3, interested: 2, could_skip: 1 };

// The three checkbox states. null = clear (unmarked); the row cycles in order.
const TL_OUTCOME_META = {
  visited: { icon: 'square-check', cls: 'is-visited', tag: 'Visited' },
  skipped: { icon: 'square-x', cls: 'is-skipped', tag: 'Skipped' },
};

function _tlOutcome(scrap) {
  if (scrap.visited_at) return 'visited';
  if (scrap.skipped_at) return 'skipped';
  return null;
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

function _tlMarkerRow(m, { canWrite = true } = {}) {
  const meta = TIMELINE_MARKER_META[m.kind] || TIMELINE_MARKER_META.checkin;
  const time = _tlTime(m.time);
  return `
    <div class="tl-row tl-row--marker">
      <span class="tl-row__time">${time ? escapeHtml(time) : 'all day'}</span>
      <i data-lucide="${meta.icon}"></i>
      <span class="tl-row__label"><b>${meta.label}</b> · ${escapeHtml(m.label)}</span>
      ${canWrite ? `
        <button class="tl-row__btn" data-action="edit-anchor" data-anchor-id="${escapeAttr(m.anchor_id)}"
                aria-label="Edit ${escapeAttr(m.label)}" title="Edit checkpoint">
          <i data-lucide="pencil"></i>
        </button>` : ''}
    </div>`;
}

// The leading checkbox. Cycles clear → Visited → Skipped → clear (the actual
// cycle lives in trip-view; this just paints the current state). Read-only
// viewers see the state as a static mark, no button.
function _tlCheckbox(scrap, canWrite) {
  const outcome = _tlOutcome(scrap);
  const state = outcome || 'clear';
  const icon = outcome ? TL_OUTCOME_META[outcome].icon : 'square';
  const label = outcome === 'visited'
    ? 'Visited — tap to mark skipped'
    : outcome === 'skipped'
      ? 'Skipped — tap to clear'
      : 'Tap to mark visited';
  if (!canWrite) {
    return `<span class="tl-check tl-check--${state} tl-check--ro" aria-hidden="true"><i data-lucide="${icon}"></i></span>`;
  }
  return `
    <button class="tl-check tl-check--${state}" data-action="cycle-outcome"
            data-scrap-id="${escapeAttr(scrap.id)}" aria-label="${label}" title="${label}">
      <i data-lucide="${icon}"></i>
    </button>`;
}

/**
 * A plan row, wrapped in the swipe/drag scaffold TimelineGestures binds to.
 * @param {object} scrap
 * @param {{canWrite?: boolean, mode?: 'scheduled'|'suggested'|'anytime'}} opts
 *   scheduled — solid, on a day; swipe-left unschedules.
 *   suggested — dashed, auto-placed near a marker; carries a "keep here" pin.
 *   anytime   — dashed, no day suggestion.
 */
function _tlPlanRow(scrap, { canWrite = true, mode = 'scheduled' } = {}) {
  const time = _tlTime(scrap.plan_time);
  const booked = mode === 'scheduled' && scrap.rating === 'booked' && !!time;
  const outcome = _tlOutcome(scrap);
  const meta = outcome ? TL_OUTCOME_META[outcome] : null;
  const sug = scrap.suggestion;
  const rowCls = [
    'tl-row', 'tl-row--plan',
    mode !== 'scheduled' ? 'tl-row--suggested' : '',
    booked ? 'tl-row--booked' : '',
    meta ? meta.cls : '',
    canWrite ? 'tl-row--draggable' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="tl-swipe" data-scrap-id="${escapeAttr(scrap.id)}" data-plan-date="${escapeAttr(scrap.plan_date || '')}">
      <div class="tl-swipe__action tl-swipe__action--schedule" aria-hidden="true">
        <i data-lucide="calendar-clock"></i><span>Schedule</span>
      </div>
      ${mode === 'scheduled' ? `
      <div class="tl-swipe__action tl-swipe__action--remove" aria-hidden="true">
        <span>Off timeline</span><i data-lucide="calendar-x"></i>
      </div>` : ''}
      <div class="${rowCls}">
        ${_tlCheckbox(scrap, canWrite)}
        <span class="tl-row__time">${time ? escapeHtml(time) : '·'}</span>
        <span class="tl-row__label">${escapeHtml(scrap.place_name || 'Saved place')}
          ${booked ? '<span class="tl-booked-badge">Booked</span>' : ''}
          ${mode === 'suggested' && sug ? `
            <span class="tl-suggested-badge" title="Near ${escapeAttr(sug.marker_label)} (${formatKm(sug.distance_km)})">
              Suggested · near ${escapeHtml(sug.marker_label)}</span>` : ''}
          ${meta ? `<span class="tl-outcome-badge tl-outcome-badge--${outcome}">${meta.tag}</span>` : ''}</span>
        ${mode === 'suggested' && canWrite && sug ? `
          <button class="tl-row__btn tl-row__btn--pin" data-action="slot"
                  data-scrap-id="${escapeAttr(scrap.id)}" data-date="${escapeAttr(sug.suggested_date)}"
                  aria-label="Keep ${escapeAttr(scrap.place_name || 'plan')} on Day ${sug.day_number}" title="Keep it here">
            <i data-lucide="pin"></i>
          </button>` : ''}
        ${canWrite ? '<span class="tl-row__grip" aria-hidden="true" title="Hold to move to another day"><i data-lucide="grip-vertical"></i></span>' : ''}
      </div>
    </div>`;
}

function _tlAnytime(plans, { canWrite = true } = {}) {
  if (!plans.length) return '';
  const sorted = [...plans].sort(_tlPlanOrder);
  return `
    <div class="sticker-card washi washi--lavender" style="padding-top:1.2rem;margin-top:1.1rem;">
      <h2 style="font-size:1.4rem;margin:0;">Anytime</h2>
      <p class="scrap-card__sub">Plans without a day yet — swipe right (or hold to drop on a day) to slot them in.</p>
      <div class="tl-day__rows" style="margin-top:0.7rem;">
        ${sorted.map((s) => _tlPlanRow(s, { canWrite, mode: 'anytime' })).join('')}
      </div>
    </div>`;
}

// Per-day plan order: finished (visited/skipped) sink to the bottom, then by
// DESCENDING priority, then timed-before-untimed, time, and name as tie-breaks.
function _tlPlanOrder(a, b) {
  const done = (s) => (s.visited_at || s.skipped_at ? 1 : 0);
  const rank = (s) => TL_PRIORITY_RANK[s.rating] || 0;
  return (done(a) - done(b)) ||
    (rank(b) - rank(a)) ||
    ((a.plan_time == null) - (b.plan_time == null)) ||
    String(a.plan_time || '').localeCompare(String(b.plan_time || '')) ||
    String(a.place_name || '').localeCompare(String(b.place_name || ''));
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
    // Arrival/departure live in the bookends, not the day rows; stays and
    // mid-trip travel legs render inside their day, chronological (structural
    // anchors of the day). Plans then follow, sorted by descending priority.
    const markerRows = d.markers
      .filter((m) => m.kind !== 'arrival' && m.kind !== 'departure')
      .slice()
      .sort((a, b) =>
        ((a.time == null) - (b.time == null)) ||
        String(a.time || '').localeCompare(String(b.time || '')))
      .map((m) => _tlMarkerRow(m, { canWrite }));
    const planRows = [...d.plans].sort(_tlPlanOrder)
      .map((p) => _tlPlanRow(p, { canWrite, mode: 'scheduled' }));
    const suggested = (suggestedByDay[d.date] || [])
      .map((s) => _tlPlanRow(s, { canWrite, mode: 'suggested' }));
    const all = [...markerRows, ...planRows, ...suggested];
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
        <button class="tl-add-btn" data-action="add-checkpoint">
          <i data-lucide="plus"></i>Checkpoint — a stay or travel leg
        </button>` : ''}
      ${_tlEndpoint(trip, 'end', { canWrite })}
    </div>
    ${_tlAnytime(anytime, { canWrite })}
  `;
}
