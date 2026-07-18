// ui/timeline-row.js — row-level renders for the unified trip Timeline. Loaded
// before ui/trip-timeline.js, which composes these into day cards.
//
// A plan row reads left→right: outcome checkbox · category sprite · time (if
// set) · tappable title (opens the plan popup) · placement indicator
// (sparkles = auto-placed by the route, pin = anchored to this day) · drag grip
// (the ONLY place a press-and-hold pick-up starts — see widgets/timeline-gestures).
// Between two consecutive located stops sits a leg connector showing the
// estimated distance + drive/walk time (domain/geo.js).
'use strict';

// The two set states of the leading checkbox. null = clear; it cycles
// clear → Visited → Skipped → clear.
const TL_OUTCOME_META = {
  visited: { icon: 'square-check', cls: 'is-visited', tag: 'Visited' },
  skipped: { icon: 'square-x', cls: 'is-skipped', tag: 'Skipped' },
};

// Auto vs anchored placement — the little icon on the right of the title.
const TL_PLACEMENT_META = {
  auto: { icon: 'sparkles', title: 'Auto-placed by the route — drag it, swipe right, or set a date to pin it here' },
  anchored: { icon: 'pin', title: 'Pinned to this day — swipe left to let the route decide again' },
};

function _tlOutcome(scrap) {
  if (scrap.visited_at) return 'visited';
  if (scrap.skipped_at) return 'skipped';
  return null;
}

function _tlTime(t) {
  return t ? t.slice(0, 5) : null;
}

// The leading checkbox. Cycles clear → Visited → Skipped → clear (the cycle
// itself lives in trip-view; this paints the current state). Read-only viewers
// see the state as a static mark, no button.
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
 * @param {{canWrite?: boolean, placement?: 'auto'|'anchored'}} opts
 *   auto     — dashed; the route placed it (ephemeral, no saved date).
 *   anchored — solid; the user pinned it to this day (plan_date is set).
 */
function _tlPlanRow(scrap, { canWrite = true, placement = 'auto' } = {}) {
  const time = _tlTime(scrap.plan_time);
  const booked = placement === 'anchored' && scrap.rating === 'booked' && !!time;
  const outcome = _tlOutcome(scrap);
  const meta = outcome ? TL_OUTCOME_META[outcome] : null;
  const pmeta = TL_PLACEMENT_META[placement] || TL_PLACEMENT_META.auto;
  const rowCls = [
    'tl-row', 'tl-row--plan',
    placement === 'auto' ? 'tl-row--auto' : '',
    booked ? 'tl-row--booked' : '',
    meta ? meta.cls : '',
    canWrite ? 'tl-row--draggable' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="tl-swipe" data-scrap-id="${escapeAttr(scrap.id)}" data-plan-date="${escapeAttr(scrap.plan_date || '')}">
      <div class="tl-swipe__action tl-swipe__action--schedule" aria-hidden="true">
        <i data-lucide="calendar-clock"></i><span>Schedule</span>
      </div>
      ${placement === 'anchored' ? `
      <div class="tl-swipe__action tl-swipe__action--remove" aria-hidden="true">
        <span>Auto</span><i data-lucide="sparkles"></i>
      </div>` : ''}
      <div class="${rowCls}">
        ${_tlCheckbox(scrap, canWrite)}
        ${renderSprite('category', scrap.category, { size: 'sm', alt: '' })}
        ${time ? `<span class="tl-row__time">${escapeHtml(time)}</span>` : ''}
        <button class="tl-row__title" data-action="open-plan" data-scrap-id="${escapeAttr(scrap.id)}">
          <span class="tl-row__name">${escapeHtml(scrap.place_name || 'Saved place')}</span>
          ${booked ? '<span class="tl-booked-badge">Booked</span>' : ''}
          ${meta ? `<span class="tl-outcome-badge tl-outcome-badge--${outcome}">${meta.tag}</span>` : ''}
        </button>
        <span class="tl-row__place" title="${escapeAttr(pmeta.title)}" aria-label="${escapeAttr(pmeta.title)}"><i data-lucide="${pmeta.icon}"></i></span>
        ${canWrite ? '<span class="tl-row__grip" aria-hidden="true" title="Hold to drag to another day"><i data-lucide="menu"></i></span>' : ''}
      </div>
    </div>`;
}

// A non-interactive connector between two consecutive located stops: a small
// footprints/car glyph + "2.3 km · ~30 min walk". Rendered just before the row
// it leads into; the first stop of a day gets no leg (leg == null → '').
function _tlLegRow(leg) {
  if (!leg) return '';
  const icon = leg.mode === 'walk' ? 'footprints' : 'car';
  return `
    <div class="tl-leg" aria-hidden="true">
      <span class="tl-leg__rail"></span>
      <i data-lucide="${icon}"></i>
      <span class="tl-leg__text">${escapeHtml(Geo.formatLeg(leg))}</span>
    </div>`;
}
