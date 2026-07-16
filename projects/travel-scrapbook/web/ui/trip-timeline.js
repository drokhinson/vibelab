// ui/trip-timeline.js — render functions for the trip's day-by-day timeline:
// one card per day (markers + scheduled plans in time order) plus the
// unscheduled pile with slot suggestions. Render-only; trip-view binds the
// [data-action=slot|schedule] buttons.
'use strict';

const TIMELINE_MARKER_META = {
  arrival: { icon: 'plane-landing', label: 'Arrive' },
  checkin: { icon: 'home', label: 'Check in' },
  checkout: { icon: 'log-out', label: 'Check out' },
  departure: { icon: 'plane-takeoff', label: 'Depart' },
};

function _tlDay(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function _tlTime(t) {
  return t ? t.slice(0, 5) : null;
}

function _tlMarkerRow(m) {
  const meta = TIMELINE_MARKER_META[m.kind] || TIMELINE_MARKER_META.arrival;
  const time = _tlTime(m.time);
  return `
    <div class="tl-row tl-row--marker">
      <span class="tl-row__time">${time ? escapeHtml(time) : 'all day'}</span>
      <i data-lucide="${meta.icon}"></i>
      <span class="tl-row__label"><b>${meta.label}</b> · ${escapeHtml(m.label)}</span>
    </div>`;
}

// A scheduled plan row. Booked + timed = a concrete booking (distinct accent).
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
                aria-label="Reschedule ${escapeAttr(scrap.place_name || 'plan')}" title="Reschedule">
          <i data-lucide="clock"></i>
        </button>` : ''}
    </div>`;
}

function _tlUnscheduled(unscheduled, { canWrite = true } = {}) {
  if (!unscheduled.length) return '';
  return `
    <div class="sticker-card washi washi--lavender" style="padding-top:1.2rem;margin-top:1.1rem;">
      <h2 style="font-size:1.4rem;margin:0;">Unscheduled</h2>
      <p class="scrap-card__sub">Plans without a day yet — slot them in.</p>
      <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:0.7rem;">
        ${unscheduled.map((s) => {
          const sug = s.suggestion;
          return `
            <div class="tl-row tl-row--plan">
              <i data-lucide="map-pin"></i>
              <span class="tl-row__label">${escapeHtml(s.place_name || 'Saved place')}</span>
              ${canWrite && sug ? `
                <button class="ts-btn ts-btn--sky ts-btn--sm" data-action="slot"
                        data-scrap-id="${escapeAttr(s.id)}" data-date="${escapeAttr(sug.suggested_date)}">
                  <i data-lucide="calendar-plus"></i>Day ${sug.day_number} · near ${escapeHtml(sug.marker_label)} (${formatKm(sug.distance_km)})
                </button>` : ''}
              ${canWrite ? `
                <button class="ts-btn ts-btn--ghost ts-btn--sm" data-action="schedule" data-scrap-id="${escapeAttr(s.id)}">
                  <i data-lucide="calendar"></i>Pick a day
                </button>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

/**
 * @param {object} trip
 * @param {object|null} data - TimelineResponse (null = loading)
 * @param {{canWrite?: boolean}} opts
 */
function renderTripTimeline(trip, data, { canWrite = true } = {}) {
  if (!data) {
    return `<div class="sticker-card shimmer" style="height:140px;margin-top:1rem;"></div>`;
  }
  if (data.reason === 'no_dates') {
    return `
      <div class="empty-state">
        <img src="/assets/illustrations/travel-scrapbook-empty-scraps.svg" alt="" />
        <p class="empty-title">No timeline yet</p>
        <p class="empty-desc">Give the trip dates (or add a dated anchor) and your days build themselves.</p>
        ${canWrite ? '<button class="ts-btn ts-btn--mint ts-btn--sm" id="tl-edit-trip"><i data-lucide="pencil"></i>Add trip dates</button>' : ''}
      </div>`;
  }
  const days = data.days || [];
  return `
    <div style="display:flex;flex-direction:column;gap:0.9rem;margin-top:1rem;">
      ${days.map((d, i) => `
        <div class="sticker-card tl-day" style="--i:${i};">
          <div class="tl-day__head">
            <span class="tl-day__num">Day ${d.day_number}</span>
            <span class="scrap-card__sub">${escapeHtml(_tlDay(d.date))}</span>
          </div>
          ${d.markers.length || d.plans.length ? `
            <div class="tl-day__rows">
              ${[...d.markers.map((m) => ({ html: _tlMarkerRow(m), time: m.time, isPlan: 0 })),
                 ...d.plans.map((p) => ({ html: _tlPlanRow(p, { canWrite }), time: p.plan_time, isPlan: 1 }))]
                .sort((a, b) =>
                  ((a.time == null) - (b.time == null)) ||
                  String(a.time || '').localeCompare(String(b.time || '')) ||
                  (a.isPlan - b.isPlan))
                .map((r) => r.html).join('')}
            </div>` : `
            <p class="scrap-card__sub" style="margin-top:0.3rem;">Free day — nothing planned yet.</p>`}
        </div>`).join('')}
    </div>
    ${_tlUnscheduled(data.unscheduled || [], { canWrite })}
  `;
}
