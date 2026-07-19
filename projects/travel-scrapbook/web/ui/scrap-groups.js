// ui/scrap-groups.js — bucket a list of scraps by a chosen dimension (activity
// type or geography). The only consumer today is ui/stop-zones.js, which turns
// the buckets into the trip Stops tab's interlocking geo "zones". Pure helper
// over the flat place fields the API already returns (place_city/region/country,
// category) — no rendering, no DOM.
'use strict';

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

window.GROUP_NONE = _GROUP_NONE; // so stop-zones can flag the missing-value bucket
window.groupScraps = groupScraps;
