// ui/scrap-groups.js — group a list of scraps into collapsible sections by a
// chosen dimension (activity type or geography). Shared by the Wander List and
// the trip view so both group identically. Pure render helpers over the flat
// place fields the API already returns (place_city/region/country, category).
'use strict';

const GROUP_DIMS = {
  category: { label: 'Activity' },
  city:     { label: 'City' },
  region:   { label: 'Region' },
  country:  { label: 'Country' },
};

const _GROUP_NONE = '__none__';

function _noneLabel(dimension) {
  return dimension === 'city' ? 'No city yet'
    : dimension === 'region' ? 'No region yet'
    : dimension === 'country' ? 'Not pinned'
    : 'Uncategorized';
}

/**
 * Bucket scraps by a dimension.
 * @param {Array} scraps
 * @param {'category'|'city'|'region'|'country'} dimension
 * @returns {Array<{key:string,label:string,items:Array}>} ordered groups —
 *   category by the seeded sort order; geography by size (largest first),
 *   with the missing-value group always last.
 */
function groupScraps(scraps, dimension) {
  const cats = window.store.get('categories') || [];
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  const groups = new Map();

  for (const s of scraps) {
    let key;
    let label;
    let sort = null;
    if (dimension === 'category') {
      const slug = s.category || 'other';
      const c = catBySlug.get(slug) || { label: 'Other', sort_order: 999 };
      key = slug; label = c.label; sort = c.sort_order ?? 999;
    } else {
      const val = dimension === 'city' ? s.place_city
        : dimension === 'region' ? s.place_region
          : s.place_country;
      if (val) { key = val.toLowerCase(); label = val; } else { key = _GROUP_NONE; label = _noneLabel(dimension); }
    }
    if (!groups.has(key)) groups.set(key, { key, label, sort, items: [] });
    groups.get(key).items.push(s);
  }

  const arr = [...groups.values()];
  if (dimension === 'category') {
    arr.sort((a, b) => (a.sort - b.sort) || a.label.localeCompare(b.label));
  } else {
    arr.sort((a, b) => {
      const an = a.key === _GROUP_NONE ? 1 : 0;
      const bn = b.key === _GROUP_NONE ? 1 : 0;
      if (an !== bn) return an - bn;                       // "none" group last
      return (b.items.length - a.items.length) || a.label.localeCompare(b.label);
    });
  }
  return arr;
}

/**
 * Keep only dimensions that actually split the list (≥2 groups). A single-value
 * dimension is pointless — e.g. "Region" on a one-country trip, or "Country" on
 * a list that's all one country — so it's dropped from the toggle.
 * @param {Array} scraps
 * @param {string[]} dims — candidate dimension keys, in preferred order
 * @returns {string[]}
 */
function availableGroupDims(scraps, dims) {
  return dims.filter((d) => groupScraps(scraps, d).length >= 2);
}

/**
 * Segmented "group by" control. Reuses the .ts-segmented styling.
 * @param {string[]} dims — dimension keys to offer, in order
 * @param {string} active — currently selected dimension
 * @param {string} name — radio group name (unique per view)
 */
function renderGroupByToggle(dims, active, name) {
  return `
    <div class="ts-segmented ts-segmented--sm scrap-groupby" role="radiogroup" aria-label="Group by">
      ${dims.map((d) => `
        <label class="ts-segmented__opt">
          <input type="radio" name="${escapeAttr(name)}" value="${escapeAttr(d)}" ${d === active ? 'checked' : ''} />
          <span>${escapeHtml(GROUP_DIMS[d].label)}</span>
        </label>`).join('')}
    </div>`;
}

/**
 * Render scraps as collapsible <details> sections grouped by `dimension`.
 * Native <details> gives free, accessible collapse; `collapsed` (a Set of group
 * keys) persists open/closed state across re-renders.
 * @param {Array} scraps
 * @param {{dimension?:string, collapsed?:Set<string>, variant?:string, tripId?:(string|null),
 *          shared?:boolean, currentUserId?:(string|null), canWrite?:boolean}} opts
 *   shared/currentUserId/canWrite forward to renderScrapCard (trip vibe + gating).
 */
function renderScrapGroups(scraps, opts = {}) {
  const {
    dimension = 'country', collapsed = new Set(), variant = 'inbox', tripId = null,
    shared = false, currentUserId = null, canWrite = true,
  } = opts;
  const groups = groupScraps(scraps, dimension);
  if (!groups.length) return '';
  let i = 0;
  return groups.map((g) => {
    const cards = g.items
      .map((s) => renderScrapCard(s, { index: i++, variant, tripId, shared, currentUserId, canWrite }))
      .join('');
    return `
      <details class="scrap-group" data-group-key="${escapeAttr(g.key)}" ${collapsed.has(g.key) ? '' : 'open'}>
        <summary class="scrap-group__summary">
          <span class="scrap-group__chev"><i data-lucide="chevron-right"></i></span>
          <span class="scrap-group__label">${escapeHtml(g.label)}</span>
          <span class="scrap-group__count">${g.items.length}</span>
        </summary>
        <div class="card-grid card-grid--2col scrap-group__grid">${cards}</div>
      </details>`;
  }).join('');
}

/**
 * Full grouped list: a "group by" toggle (only dimensions that split the list)
 * plus collapsible grouped sections. When no dimension splits the list (e.g. a
 * handful of items all in one country), it renders a plain flat grid with no
 * toggle. The chosen `active` dimension falls back to the first available one.
 * @param {Array} scraps
 * @param {{dims:string[], active:string, collapsed?:Set<string>, variant?:string, tripId?:(string|null),
 *          name:string, shared?:boolean, currentUserId?:(string|null), canWrite?:boolean}} opts
 */
function renderGroupedList(scraps, opts = {}) {
  const {
    dims, active, collapsed = new Set(), variant = 'inbox', tripId = null, name,
    shared = false, currentUserId = null, canWrite = true,
  } = opts;
  const card = { variant, tripId, shared, currentUserId, canWrite };
  const avail = availableGroupDims(scraps, dims);
  if (!avail.length) {
    return `<div class="card-grid card-grid--2col">${
      scraps.map((s, i) => renderScrapCard(s, { index: i, ...card })).join('')
    }</div>`;
  }
  const eff = avail.includes(active) ? active : avail[0];
  return renderGroupByToggle(avail, eff, name) +
    renderScrapGroups(scraps, { dimension: eff, collapsed, ...card });
}

// Wire the group-by radios + the <details> collapse state into a view. Call
// from a view's _bind after setting innerHTML.
//  - onChange(dim): the view stores the new dimension, clears collapsed, re-renders
//  - collapsed: the view's Set, kept in sync as the user expands/collapses
function bindScrapGroups(container, { name, collapsed, onChange }) {
  container.querySelectorAll(`.scrap-groupby input[name="${name}"]`).forEach((radio) => {
    radio.addEventListener('change', () => { if (radio.checked) onChange(radio.value); });
  });
  container.querySelectorAll('details.scrap-group').forEach((d) => {
    d.addEventListener('toggle', () => {
      const key = d.dataset.groupKey;
      if (d.open) collapsed.delete(key); else collapsed.add(key);
    });
  });
}

window.GROUP_NONE = _GROUP_NONE; // so plan-zones can flag the missing-value bucket
window.groupScraps = groupScraps;
window.availableGroupDims = availableGroupDims;
window.renderGroupByToggle = renderGroupByToggle;
window.renderScrapGroups = renderScrapGroups;
window.renderGroupedList = renderGroupedList;
window.bindScrapGroups = bindScrapGroups;
