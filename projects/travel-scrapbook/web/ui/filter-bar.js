// ui/filter-bar.js — geographic drill-down filter row for the browse views
// (Wander List, Visited, Community). Selected levels render as removable
// chips in a horizontal scroll; ONE dropdown offers the next level:
// Region → Country (only countries with data) → City. Clearing a chip also
// clears every deeper level.
'use strict';

const GEO_LEVELS = ['region', 'country', 'city'];
const GEO_LEVEL_LABEL = { region: 'Region', country: 'Country', city: 'City' };
const GEO_LEVEL_ICON = { region: 'globe-2', country: 'flag', city: 'building-2' };

/**
 * @param {{region?: (string|null), country?: (string|null), city?: (string|null)}} geo
 * @param {{regions?: string[], countries?: string[], cities?: string[]}} facets
 */
function renderFilterBar(geo = {}, facets = {}) {
  const chips = GEO_LEVELS.filter((l) => geo[l]).map((l) => `
    <span class="filter-chip">
      <i data-lucide="${GEO_LEVEL_ICON[l]}"></i>${escapeHtml(geo[l])}
      <button class="filter-chip__x" data-action="geo-clear" data-level="${l}"
              aria-label="Clear ${GEO_LEVEL_LABEL[l]} filter"><i data-lucide="x"></i></button>
    </span>`).join('');

  // The next unfilled drill level with options to offer.
  let nextLevel = null;
  let options = [];
  if (!geo.region && (facets.regions || []).length) {
    nextLevel = 'region'; options = facets.regions;
  } else if (geo.region && !geo.country && (facets.countries || []).length) {
    nextLevel = 'country'; options = facets.countries;
  } else if (geo.country && !geo.city && (facets.cities || []).length) {
    nextLevel = 'city'; options = facets.cities;
  }
  const dropdown = nextLevel ? `
    <select class="filter-bar__select" data-action="geo-select" data-level="${nextLevel}"
            aria-label="Filter by ${GEO_LEVEL_LABEL[nextLevel]}">
      <option value="" selected disabled>${GEO_LEVEL_LABEL[nextLevel]}…</option>
      ${options.map((o) => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('')}
    </select>` : '';

  if (!chips && !dropdown) return '';
  return `<div class="filter-bar">${chips}${dropdown}</div>`;
}

/**
 * @param {Element} container
 * @param {{geo: object, onChange: (geo: object) => void}} opts
 *   onChange receives the new {region, country, city} after a pick or clear.
 */
function bindFilterBar(container, { geo = {}, onChange } = {}) {
  container.querySelectorAll('[data-action=geo-select]').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      onChange?.({ ...geo, [sel.dataset.level]: sel.value });
    });
  });
  container.querySelectorAll('[data-action=geo-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = { ...geo };
      // Clearing a level clears everything deeper too.
      const from = GEO_LEVELS.indexOf(btn.dataset.level);
      GEO_LEVELS.slice(from).forEach((l) => { next[l] = null; });
      onChange?.(next);
    });
  });
}
