// ui/plan-zones.js — the trip Plans layout: all plan cards in ONE continuous
// grid, auto-grouped by geography. Instead of a rectangular box per region
// (which wastes a half-row whenever a region has an odd card count), cards pack
// into a single gap-less grid in region order, and each region is shown by
// tinting its cells + tracing a dotted outline around exactly the cells it
// occupies — so regions interlock like tetris pieces with no wasted space.
// The grouping dimension is picked from the trip's granularity (scope_level).
// Pure render over the flat place fields, reusing groupScraps + renderScrapCard.
'use strict';

// scope_level → ordered geo-dim preference. The first dim that actually splits
// the trip's places into ≥2 groups wins; if none does, we fall back to a plain
// grid (no zones). A city-scoped trip has no finer geo field, so it maps to []
// — kept as an explicit entry so the nullish fallback below never swallows it.
const _ZONE_PREF = {
  region: ['country', 'city'],
  country: ['city'],
  city: [],
};
const _ZONE_PREF_DEFAULT = ['country', 'city', 'region'];

// Fixed column count — the dotted-boundary math below assumes a stable grid
// width, so the plan grid stays 2-up at every size (see .plan-zones-grid CSS).
const _ZONE_COLS = 2;

// Stable label→colour so a region keeps its tint across re-renders (a fresh
// hash each paint would make zones flicker between colours).
const _ZONE_TINTS = ['blush', 'mint', 'sky', 'butter', 'lavender', 'terracotta'];
function _zoneTint(label) {
  let h = 0;
  for (let k = 0; k < label.length; k++) h = (h * 31 + label.charCodeAt(k)) >>> 0;
  return _ZONE_TINTS[h % _ZONE_TINTS.length];
}

/**
 * Render trip plans as interlocking geography zones.
 * @param {Array} scraps
 * @param {{scopeLevel?:string, variant?:string, tripId?:(string|null),
 *          shared?:boolean, currentUserId?:(string|null), canWrite?:boolean}} opts
 * @returns {string}
 */
function renderPlanZones(scraps, opts = {}) {
  const {
    scopeLevel, variant = 'trip', tripId = null,
    shared = false, currentUserId = null, canWrite = true,
  } = opts;
  const card = { variant, tripId, shared, currentUserId, canWrite };

  // Nullish (not ||): scope 'city' → [] is intentional and must NOT fall to the
  // default; only a missing/unknown scope uses the default preference.
  const pref = (scopeLevel in _ZONE_PREF) ? _ZONE_PREF[scopeLevel] : _ZONE_PREF_DEFAULT;
  const dim = pref.find((d) => window.groupScraps(scraps, d).length >= 2);

  // No geo dimension splits the list (single-region/city trip, or city scope) →
  // plain grid, nothing to interlock.
  if (!dim) {
    return `<div class="card-grid card-grid--2col">${
      scraps.map((s, i) => renderScrapCard(s, { index: i, ...card })).join('')
    }</div>`;
  }

  // Flatten groups into one ordered cell list, tagging each cell with its region
  // key/label/tint and whether it's the region's first cell (gets the title).
  const groups = window.groupScraps(scraps, dim);
  const cells = [];
  for (const g of groups) {
    const tint = g.key === window.GROUP_NONE ? 'neutral' : _zoneTint(g.label);
    g.items.forEach((s, gi) => cells.push({
      scrap: s, key: g.key, label: g.label, tint, start: gi === 0, count: g.items.length,
    }));
  }
  const N = cells.length;
  const regionAt = (idx) => (idx >= 0 && idx < N ? cells[idx].key : null);

  const inner = cells.map((cell, i) => {
    const g = cell.key;
    const col = i % _ZONE_COLS;
    // Draw each boundary line exactly once: outer grid edges by the edge cell;
    // internal region↔region seams by the upper/left cell (as its bottom/right).
    const sides = [];
    if (i - _ZONE_COLS < 0) sides.push('top');                                  // grid top edge
    if (col === 0) sides.push('left');                                          // grid left edge
    if (i + _ZONE_COLS >= N || regionAt(i + _ZONE_COLS) !== g) sides.push('bottom'); // edge or seam below
    if (col === _ZONE_COLS - 1 || i + 1 >= N || regionAt(i + 1) !== g) sides.push('right'); // edge or seam right
    const border = sides.map((s) => `border-${s}:var(--zone-line);`).join('');

    const label = cell.start
      ? `<span class="zone-cell__label">${escapeHtml(cell.label)}<span class="zone-cell__count">${cell.count}</span></span>`
      : '';
    return `
      <div class="zone-cell plan-zone--${cell.tint}${cell.start ? ' zone-cell--start' : ''}" style="--i:${i};${border}">
        ${label}${renderScrapCard(cell.scrap, { index: i, ...card })}
      </div>`;
  }).join('');

  return `<div class="plan-zones-grid">${inner}</div>`;
}

window.renderPlanZones = renderPlanZones;
