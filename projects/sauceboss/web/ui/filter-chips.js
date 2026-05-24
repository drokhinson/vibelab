'use strict';

// Shared filter-chip block used by Browse and Saucebook (and, after PR 10,
// the Sauce Manager). Renders three sections: Type pills, Cuisine search +
// chips, and (optionally) Compatible-Dish search + chips. The caller passes
// active sets and JS-expression templates with `$NAME` / `$VALUE` / `$ID`
// placeholders for the per-chip click handlers.
//
// opts:
//   activeCuisines   — Set<string> of currently selected cuisine names
//   activeTypes      — Set<string> of currently selected type values
//   activeDishes     — Set<string> of currently selected dish ids (optional)
//   onCuisine        — JS expression template with `$NAME` placeholder
//   onType           — JS expression template with `$VALUE` placeholder
//   onDish           — JS expression template with `$ID` placeholder (opt-in)
//   cuisineFilterQ   — current cuisine search input value
//   dishFilterQ      — current dish search input value
//   onCuisineFilterQ — JS expression for cuisine input's oninput handler
//   onDishFilterQ    — JS expression for dish input's oninput handler
//   cuisineSource    — override list of cuisines (defaults to availableCuisines())
//   dishSource       — override list of dishes (defaults to state.allFilterDishes)
//   cuisineFilterKey / dishFilterKey — focus-restore keys
function renderFilterChips(opts) {
  // ── Cuisine: search-input → dropdown → multi-select chips ──────────────
  const allCuisines = opts.cuisineSource || availableCuisines();
  const cuisineQ = (opts.cuisineFilterQ || '').trim().toLowerCase();
  const activeCuisines = opts.activeCuisines || new Set();

  // Selected chips (always visible)
  const cuisineSelected = [...activeCuisines].map(name => {
    const c = allCuisines.find(x => x.name === name);
    const emoji = c ? renderEmoji(c.emoji) + ' ' : '';
    const handler = opts.onCuisine.replace('$NAME', escapeHtml(name));
    return `<button class="toggle-chip toggle-chip--active" onclick="${handler}">${emoji}${escapeHtml(name)} ✕</button>`;
  }).join('');

  // Suggestion dropdown (only when typing, hide already-selected)
  const cuisineSuggestions = cuisineQ
    ? allCuisines.filter(c => !activeCuisines.has(c.name) && c.name.toLowerCase().includes(cuisineQ))
    : [];
  const cuisineSuggestHTML = cuisineSuggestions.length ? `
    <div class="browse-filters__suggest">
      ${cuisineSuggestions.map(c => {
        const handler = opts.onCuisine.replace('$NAME', escapeHtml(c.name));
        return `<button onclick="${handler}">${renderEmoji(c.emoji)} ${escapeHtml(c.name)}</button>`;
      }).join('')}
    </div>` : '';

  // ── Type: simple toggle chips (short list, no search needed) ───────────
  const typeChips = SAUCE_TYPES.map(t => {
    const active = (opts.activeTypes || new Set()).has(t.value) ? ' toggle-chip--active' : '';
    const handler = opts.onType.replace('$VALUE', t.value);
    return `<button class="toggle-chip${active}" onclick="${handler}">${escapeHtml(t.label)}</button>`;
  }).join('');

  // ── Dish: search-input → dropdown → multi-select chips ────────────────
  let dishHTML = '';
  if (opts.onDish) {
    const allDishes = opts.dishSource || (state.allFilterDishes || []);
    const dishQ = (opts.dishFilterQ || '').trim().toLowerCase();
    const activeDishes = opts.activeDishes || new Set();

    const dishSelected = [...activeDishes].map(id => {
      const d = allDishes.find(x => x.id === id);
      const label = d ? (d.emoji ? renderEmoji(d.emoji) + ' ' : '') + escapeHtml(d.name) : escapeHtml(id);
      const handler = opts.onDish.replace('$ID', escapeHtml(id));
      return `<button class="toggle-chip toggle-chip--active" onclick="${handler}">${label} ✕</button>`;
    }).join('');

    const dishSuggestions = dishQ
      ? allDishes.filter(d => !activeDishes.has(d.id) && d.name.toLowerCase().includes(dishQ))
      : [];
    const dishSuggestHTML = dishSuggestions.length ? `
      <div class="browse-filters__suggest">
        ${dishSuggestions.map(d => {
          const handler = opts.onDish.replace('$ID', escapeHtml(d.id));
          return `<button onclick="${handler}">${d.emoji ? renderEmoji(d.emoji) + ' ' : ''}${escapeHtml(d.name)}</button>`;
        }).join('')}
      </div>` : '';

    dishHTML = `
      <span class="browse-filters__label" style="margin-top:10px;display:block">Compatible Dish</span>
      <input
        type="text"
        class="browse-filters__filter-input"
        placeholder="Search dishes…"
        data-focus-key="${opts.dishFilterKey || 'dish-filter'}"
        value="${escapeHtml(opts.dishFilterQ || '')}"
        oninput="${opts.onDishFilterQ}"
      />
      ${dishSuggestHTML}
      ${dishSelected ? `<div class="browse-filters__row" style="margin-top:6px">${dishSelected}</div>` : ''}
    `;
  }

  return `
    <span class="browse-filters__label">Type</span>
    <div class="browse-filters__row">${typeChips}</div>
    <span class="browse-filters__label" style="margin-top:10px;display:block">Cuisine</span>
    <input
      type="text"
      class="browse-filters__filter-input"
      placeholder="Search cuisines…"
      data-focus-key="${opts.cuisineFilterKey || 'cuisine-filter'}"
      value="${escapeHtml(opts.cuisineFilterQ || '')}"
      oninput="${opts.onCuisineFilterQ || ''}"
    />
    ${cuisineSuggestHTML}
    ${cuisineSelected ? `<div class="browse-filters__row" style="margin-top:6px">${cuisineSelected}</div>` : ''}
    ${dishHTML}
  `;
}
