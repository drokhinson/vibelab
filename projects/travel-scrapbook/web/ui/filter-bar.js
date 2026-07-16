// ui/filter-bar.js — geographic filter row shared by the browse views
// (Wander List, Visited, Community). Three dropdowns — Region, Country,
// City — always visible when they have options, each defaulting to "All …".
// Picking a shallower level clears the deeper ones (a new region resets
// country + city); "All …" clears that level and everything deeper.
'use strict';

const GEO_LEVELS = ['region', 'country', 'city'];
const GEO_LEVEL_ALL = { region: 'All regions', country: 'All countries', city: 'All cities' };
const GEO_LEVEL_FACET = { region: 'regions', country: 'countries', city: 'cities' };

/**
 * @param {{region?: (string|null), country?: (string|null), city?: (string|null)}} geo
 * @param {{regions?: string[], countries?: string[], cities?: string[]}} facets
 */
function renderFilterBar(geo = {}, facets = {}) {
  const selects = GEO_LEVELS.map((level) => {
    const selected = geo[level] || '';
    let options = facets[GEO_LEVEL_FACET[level]] || [];
    // Defensive: a stale selection not in the facet list still renders picked.
    if (selected && !options.includes(selected)) options = [selected, ...options];
    if (!options.length) return '';
    return `
      <select class="filter-bar__select ${selected ? 'is-active' : ''}" data-action="geo-select" data-level="${level}"
              aria-label="Filter by ${level}">
        <option value="" ${selected ? '' : 'selected'}>${GEO_LEVEL_ALL[level]}</option>
        ${options.map((o) => `<option value="${escapeAttr(o)}" ${o === selected ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>`;
  }).join('');

  if (!selects.trim()) return '';
  return `<div class="filter-bar">${selects}</div>`;
}

/**
 * @param {Element} container
 * @param {{geo: object, onChange: (geo: object) => void}} opts
 *   onChange receives the new {region, country, city} after any pick.
 */
function bindFilterBar(container, { geo = {}, onChange } = {}) {
  container.querySelectorAll('[data-action=geo-select]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const level = sel.dataset.level;
      const next = { ...geo, [level]: sel.value || null };
      // A change at one level invalidates everything deeper.
      GEO_LEVELS.slice(GEO_LEVELS.indexOf(level) + 1).forEach((l) => { next[l] = null; });
      onChange?.(next);
    });
  });
}
