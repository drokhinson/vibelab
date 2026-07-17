// ui/plan-zones.js — the trip Plans layout: all plan cards in ONE section, but
// auto-grouped by geography into visually-distinct "zones" (a dotted-outline
// highlight area with a per-region colour tint + title). Unlike the Wander
// List's renderGroupedList, there's no group-by toggle and no collapse — the
// grouping dimension is picked from the trip's granularity (scope_level). Pure
// render over the flat place fields, reusing groupScraps + renderScrapCard.
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

// Stable label→colour so a region keeps its tint across re-renders (a fresh
// hash each paint would make zones flicker between colours).
const _ZONE_TINTS = ['blush', 'mint', 'sky', 'butter', 'lavender', 'terracotta'];
function _zoneTint(label) {
  let h = 0;
  for (let k = 0; k < label.length; k++) h = (h * 31 + label.charCodeAt(k)) >>> 0;
  return _ZONE_TINTS[h % _ZONE_TINTS.length];
}

/**
 * Render trip plans as geography zones.
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
  // plain grid, identical to renderGroupedList's no-split fallback.
  if (!dim) {
    return `<div class="card-grid card-grid--2col">${
      scraps.map((s, i) => renderScrapCard(s, { index: i, ...card })).join('')
    }</div>`;
  }

  const groups = window.groupScraps(scraps, dim);
  let i = 0; // running index across zones so the --i entrance stagger is continuous
  return groups.map((g) => {
    const isNone = g.key === window.GROUP_NONE;
    const tint = isNone ? 'neutral' : _zoneTint(g.label);
    const cards = g.items
      .map((s) => renderScrapCard(s, { index: i++, ...card }))
      .join('');
    return `
      <section class="plan-zone plan-zone--${tint}">
        <span class="plan-zone__title">${escapeHtml(g.label)}<span class="plan-zone__count">${g.items.length}</span></span>
        <div class="card-grid card-grid--2col">${cards}</div>
      </section>`;
  }).join('');
}

window.renderPlanZones = renderPlanZones;
