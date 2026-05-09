'use strict';
// @ts-check
//
// Saucebook tab — the user's personal recipe library. References, not copies:
// adding a recipe from Browse stores a (user_id, sauce_id) row; the author
// is preserved on the underlying sauce. Editing a non-owned recipe forks
// into a variant under the family root (handled server-side; the builder
// reacts to the `forkedId` response).
//
// Layout mirrors the Browse tab so list items look identical:
//   • Header — title + search bar.
//   • Filter toggle — same collapsible panel as Browse with cuisine chips,
//     type chips, and an author chip-list (no autocomplete needed; the
//     saucebook is small enough to render every authoring user as a chip).
//   • Body — sauces grouped by cuisine (one accordion per cuisine).
//     Rows are rendered via the shared `renderRecipeRow` helper from
//     helpers.js so they're visually identical to Browse rows.
//   • Missing-ingredient note — each row shows a "Missing N" badge if any
//     of its ingredients are flagged in the user's pantry. The badge is a
//     visual hint only; the row stays clickable so the user can still open
//     the recipe and see the substitution suggestions.
//   • Two FABs (lower-right) — chef's-hat opens the meal builder; plus
//     opens the recipe builder.

function renderSaucebook() {
  const f = _ensureSaucebookFilters();
  const sauces = state.saucebook || [];
  const search = (state.saucebookSearch || '').trim().toLowerCase();

  const filtered = sauces.filter(s => {
    if (search) {
      const hay = `${s.name || ''} ${s.cuisine || ''} ${s.authorName || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (f.cuisines.size && !f.cuisines.has(s.cuisine)) return false;
    if (f.types.size    && !f.types.has(s.sauceType)) return false;
    if (f.authorId      && (s.createdBy || '__none__') !== f.authorId) return false;
    return true;
  });

  // Build family map across the FILTERED list so cuisine groups only show
  // sauces that survived the filter. buildSauceFamilies returns a Map keyed
  // by root id.
  const familyMap = buildSauceFamilies(filtered);

  // Group displayed-row entries (one per family) by cuisine.
  const byCuisine = new Map();
  for (const family of familyMap.values()) {
    const displayed = pickDisplayedFromFamily(family);
    if (!displayed) continue;
    const cuisine = displayed.cuisine || 'Other';
    if (!byCuisine.has(cuisine)) byCuisine.set(cuisine, []);
    byCuisine.get(cuisine).push({ family, displayed });
  }
  const cuisinesSorted = [...byCuisine.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return `
    <div class="screen-wrap">
      <div class="tab-screen-header">
        <h1>Saucebook</h1>
        <p class="subtitle">Your recipe library</p>
      </div>
      <div class="scroll-body">
        ${sauces.length === 0 ? _saucebookEmptyState() : ''}
        ${sauces.length > 0 ? `
          <div class="tab-filter-row">
            <button class="browse-filters__toggle" onclick="saucebookToggleFilters()">
              <span><i data-lucide="sliders-horizontal"></i> Filters</span>
              <i data-lucide="${f.open ? 'chevron-up' : 'chevron-down'}"></i>
            </button>
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
          ${_saucebookFiltersPanel(f, sauces)}
        ` : ''}
        ${sauces.length > 0 && filtered.length === 0
          ? `<div class="empty-state">No recipes match your filters.</div>` : ''}
        ${cuisinesSorted.map(([cuisine, rows]) => _saucebookCuisineGroup(cuisine, rows)).join('')}
      </div>
      ${_saucebookFabs()}
    </div>
  `;
}

// Mirror Browse's filter affordances. The cuisine + type chips drive the
// `filtered` view above; cuisines that survive filtering still get their own
// accordion in the body. The author list is derived locally from the loaded
// saucebook (small enough — <100 sauces in practice) instead of hitting the
// /authors endpoint, so this stays a single round-trip from auth.
function _saucebookFiltersPanel(f, sauces) {
  if (!f.open) return '';
  const cuisines = availableCuisines();
  // Distinct authors present in the saucebook (excluding seed sauces with no
  // createdBy — those collapse under the "SauceBoss" pseudo-author).
  const authorMap = new Map();
  for (const s of sauces) {
    const id = s.createdBy || '__seed__';
    const name = s.authorName || (s.createdBy ? 'Unknown' : 'SauceBoss');
    if (!authorMap.has(id)) authorMap.set(id, { id, name, count: 0 });
    authorMap.get(id).count += 1;
  }
  const authors = [...authorMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  return `
      <div class="browse-filters">
        <span class="browse-filters__label">Cuisine</span>
        <div class="browse-filters__row">
          ${cuisines.map(c => `
            <button
              class="browse-filters__chip ${f.cuisines.has(c.name) ? 'browse-filters__chip--active' : ''}"
              onclick="saucebookToggleCuisineFilter('${escapeHtml(c.name)}')">${renderEmoji(c.emoji)} ${escapeHtml(c.name)}</button>
          `).join('')}
        </div>

        <span class="browse-filters__label" style="margin-top:10px;display:block">Type</span>
        <div class="browse-filters__row">
          ${SAUCE_TYPES.map(t => `
            <button
              class="browse-filters__chip ${f.types.has(t.value) ? 'browse-filters__chip--active' : ''}"
              onclick="saucebookToggleTypeFilter('${t.value}')">${escapeHtml(t.label)}</button>
          `).join('')}
        </div>

        <span class="browse-filters__label" style="margin-top:10px;display:block">Author</span>
        <div class="browse-filters__row">
          ${authors.map(a => `
            <button
              class="browse-filters__chip ${f.authorId === a.id ? 'browse-filters__chip--active' : ''}"
              onclick="saucebookPickAuthor('${escapeHtml(a.id)}')">${escapeHtml(a.name)} <span style="opacity:0.6">· ${a.count}</span></button>
          `).join('')}
        </div>

        ${(f.cuisines.size || f.types.size || f.authorId) ? `
          <button class="browse-filters__chip" style="margin-top:10px" onclick="saucebookClearFilters()">Clear filters ✕</button>
        ` : ''}
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
      ${open ? `<div class="cuisine-group__body">${rows.map(r => _saucebookRenderRow(r)).join('')}</div>` : ''}
    </div>
  `;
}

function _saucebookRenderRow({ family, displayed }) {
  const totalVersions = 1 + (family.variants ? family.variants.length : 0);
  const missingCount = sauceMissingCount(displayed);
  // Wrap the shared row in the swipe primitive (web/swipe.js). The row's
  // own click is dispatched via data-tap-action so the swipe handler can
  // distinguish between a tap (opens the recipe) and a horizontal drag
  // past 60px (commits edit on right swipe / remove on left swipe).
  const safeId = escapeHtml(displayed.id);
  const inner = renderRecipeRow(displayed, {
    variantCount: totalVersions,
    missingCount,
    onClick: '',
  });
  return `
    <div class="swipe-row swipe-row--saucebook" data-swipe
         data-tap-action="saucebookOpenRecipe('${safeId}')"
         data-edit-action="openBuilderEdit('${safeId}')"
         data-delete-action="recipeRemoveFromSaucebook('${safeId}')">
      <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
      <div class="swipe-action swipe-action-delete" aria-hidden="true">Remove</div>
      <div class="swipe-content">${inner}</div>
    </div>
  `;
}

// ── Filter state helpers ─────────────────────────────────────────────────────

function _ensureSaucebookFilters() {
  if (!state.saucebookFilters) {
    state.saucebookFilters = {
      open: false,
      cuisines: new Set(),
      types: new Set(),
      authorId: null,
    };
  }
  return state.saucebookFilters;
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

function saucebookToggleFilters() {
  const f = _ensureSaucebookFilters();
  f.open = !f.open;
  render();
}

function saucebookToggleCuisineFilter(name) {
  const f = _ensureSaucebookFilters();
  if (f.cuisines.has(name)) f.cuisines.delete(name);
  else f.cuisines.add(name);
  render();
}

function saucebookToggleTypeFilter(value) {
  const f = _ensureSaucebookFilters();
  if (f.types.has(value)) f.types.delete(value);
  else f.types.add(value);
  render();
}

function saucebookPickAuthor(id) {
  const f = _ensureSaucebookFilters();
  f.authorId = (f.authorId === id) ? null : id;
  render();
}

function saucebookClearFilters() {
  const f = _ensureSaucebookFilters();
  f.cuisines = new Set();
  f.types = new Set();
  f.authorId = null;
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
