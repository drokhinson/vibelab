'use strict';
// @ts-check
//
// Saucebook tab — the user's personal recipe library. References, not copies:
// adding a recipe from Browse stores a (user_id, sauce_id) row; the author
// is preserved on the underlying sauce. Editing a non-owned recipe forks
// into a variant under the family root (handled server-side; the builder
// reacts to the `forkedId` response).
//
// Layout:
//   • Header: title + search.
//   • Body: cuisine accordions (buildSauceFamilies + pickDisplayedFromFamily
//     reused from shared/families.js). One row per family root with the most
//     recently favorited variant displayed; family count surfaces as a chip.
//   • Two floating action buttons (lower-right): chef's-hat opens the meal
//     builder, plus opens the recipe builder.

function renderSaucebook() {
  const sauces = state.saucebook || [];
  const search = (state.saucebookSearch || '').trim().toLowerCase();
  const filtered = search
    ? sauces.filter(s =>
        (s.name || '').toLowerCase().includes(search) ||
        (s.cuisine || '').toLowerCase().includes(search) ||
        (s.authorName || '').toLowerCase().includes(search))
    : sauces;

  const families = buildSauceFamilies(filtered);

  // Group families by cuisine for the accordion. Each family has a "displayed"
  // variant (the most recently favorited one) — that's the row we render.
  const byCuisine = new Map();
  for (const fam of families) {
    const displayed = _saucebookDisplayed(fam);
    if (!displayed) continue;
    const cuisine = displayed.cuisine || 'Other';
    if (!byCuisine.has(cuisine)) byCuisine.set(cuisine, []);
    byCuisine.get(cuisine).push({ family: fam, displayed });
  }
  const cuisinesSorted = [...byCuisine.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const empty = sauces.length === 0;
  return `
    <div class="screen-wrap">
      <div class="tab-screen-header">
        <h1>Saucebook</h1>
        <p class="subtitle">Your recipe library</p>
        <div class="tab-search">
          <i data-lucide="search"></i>
          <input
            type="search"
            placeholder="Search your saucebook"
            value="${escapeHtml(state.saucebookSearch || '')}"
            oninput="saucebookSetSearch(this.value)"
          />
        </div>
      </div>
      <div class="scroll-body">
        ${empty ? _saucebookEmptyState() : ''}
        ${!empty && filtered.length === 0
          ? `<div class="empty-state">No recipes match "${escapeHtml(search)}".</div>`
          : ''}
        ${cuisinesSorted.map(([cuisine, rows]) => _saucebookCuisineGroup(cuisine, rows)).join('')}
      </div>
      ${_saucebookFabs()}
    </div>
  `;
}

function _saucebookEmptyState() {
  return `
    <div class="tab-locked">
      <i data-lucide="book-open"></i>
      <h2>Your saucebook is empty</h2>
      <p>Upload your first recipe with the + button — or browse from the existing collection and add what looks good.</p>
      <button class="btn-primary" onclick="setActiveTab('browse')">Open Browse</button>
    </div>
  `;
}

function _saucebookFabs() {
  return `
    <div class="saucebook-fabs">
      <button class="saucebook-fab saucebook-fab--meal" aria-label="Build a meal" onclick="startMealBuilder()">
        <i data-lucide="chef-hat"></i>
      </button>
      <button class="saucebook-fab saucebook-fab--add" aria-label="Add recipe" onclick="openBuilder()">
        <i data-lucide="plus"></i>
      </button>
    </div>
  `;
}

function _saucebookCuisineGroup(cuisine, rows) {
  const open = state.cuisineSections[cuisine] !== false; // default open
  return `
    <div class="cuisine-group">
      <div class="cuisine-group__header" onclick="saucebookToggleCuisine('${escapeHtml(cuisine)}')">
        <span>${escapeHtml(cuisine)}</span>
        <span class="cuisine-group__count">${rows.length}</span>
      </div>
      ${open ? `<div class="cuisine-group__body">${rows.map(r => _saucebookRow(r.displayed, r.family)).join('')}</div>` : ''}
    </div>
  `;
}

function _saucebookRow(sauce, family) {
  const type = SAUCE_TYPES.find(t => t.value === sauce.sauceType);
  const typeLabel = type ? type.label : sauce.sauceType;
  const author = sauce.authorName || (sauce.createdBy ? 'Unknown' : 'SauceBoss');
  const variantCount = (family && family.length > 1) ? family.length : 0;
  const variantTag = variantCount > 0 ? `<span class="recipe-row__variants">${variantCount} variants</span>` : '';
  return `
    <div class="recipe-row" onclick="saucebookOpenRecipe('${escapeHtml(sauce.id)}')">
      <span class="recipe-row__color" style="background:${sauce.color || '#E85D04'}"></span>
      <div class="recipe-row__main">
        <div class="recipe-row__name">${escapeHtml(sauce.name)}</div>
        <div class="recipe-row__meta">
          <span class="recipe-row__type">${escapeHtml(typeLabel)}</span>
          <span class="recipe-row__author">by ${escapeHtml(author)}</span>
          ${variantTag}
        </div>
      </div>
    </div>
  `;
}

function _saucebookDisplayed(family) {
  if (!family || !family.length) return null;
  // pickDisplayedFromFamily returns an entry from the family using the
  // user's favorites map to break ties (most-recent-favorite first), and
  // falls back to the family root when nothing is favorited.
  if (typeof pickDisplayedFromFamily === 'function') {
    return pickDisplayedFromFamily(family, state.favorites, currentUser);
  }
  return family[0];
}

// ── Mutations ────────────────────────────────────────────────────────────────

function saucebookSetSearch(q) {
  state.saucebookSearch = q;
  render();
}

function saucebookToggleCuisine(name) {
  state.cuisineSections[name] = !(state.cuisineSections[name] !== false);
  render();
}

function saucebookOpenRecipe(sauceId) {
  // Saucebook rows already carry the full envelope (api.listSaucebook
  // mirrors get_sauceboss_all_sauces_full's shape), so we can navigate to
  // the recipe view without an extra round-trip.
  const all = state.saucebook;
  const found = all.find(s => s.id === sauceId);
  if (!found) return;
  // Build the family from the saucebook so the recipe view's variant
  // switcher works.
  const rootId = found.parentSauceId || found.id;
  const family = all.filter(s => s.id === rootId || s.parentSauceId === rootId);
  state.selectedSauce = found;
  state.selectedSauceFamily = family.length ? family : [found];
  state.selectedItem = null;
  state.recipeReturnTo = 'tab-shell';
  navigate('recipe');
}
