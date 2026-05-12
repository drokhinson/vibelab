'use strict';
// @ts-check
//
// Browse tab — read-only paginated listing of every sauce family root in the
// catalog. Anon users land here on first load; logged-in users use it to add
// recipes from other authors (or seeds) to their saucebook.
//
// Data source: api.browseSauces() / state.browse. Filters: cuisine multi,
// type multi, author autocomplete. Sort: created_at DESC (DB-side).

let _browseDebounce = null;
let _authorDebounce = null;

function renderBrowse() {
  const b = state.browse;
  const pageSize = b.pageSize || 20;
  const totalPages = Math.max(1, Math.ceil((b.total || 0) / pageSize));
  const currentPage = (b.page || 0) + 1; // 1-indexed for display
  const fromIdx = b.total === 0 ? 0 : (b.page * pageSize) + 1;
  const toIdx = Math.min(b.total, (b.page + 1) * pageSize);

  return `
    <div class="screen-wrap">
      ${renderAppHeader({ title: 'Browse', subtitle: 'Discover recipes from every cuisine' })}
      <div class="scroll-body">
        <div class="tab-filter-row">
          <button class="browse-filters__toggle" onclick="browseToggleFilters()">
            <span><i data-lucide="sliders-horizontal"></i> Filters</span>
            <i data-lucide="${b.filtersOpen ? 'chevron-up' : 'chevron-down'}"></i>
          </button>
          <div class="tab-search">
            <i data-lucide="search"></i>
            <input
              type="search"
              placeholder="Search by name"
              data-focus-key="browse-search"
              value="${escapeHtml(b.q)}"
              oninput="browseSetQuery(this.value)"
              onkeydown="if(event.key==='Enter')browseRunSearch()"
            />
          </div>
        </div>

        ${b.filtersOpen ? `
          <div class="browse-filters">
            ${renderFilterChips({
              activeCuisines: b.cuisines,
              cuisineFilterQ: b.cuisineFilterQ,
              cuisineFilterKey: 'browse-cuisine-filter',
              onCuisineFilterQ: "browseCuisineFilterQ(this.value)",
              activeTypes: b.types,
              onCuisine: "browseToggleCuisine('$NAME')",
              onType: "browseToggleType('$VALUE')",
              activeDishes: b.dishes,
              dishFilterQ: b.dishFilterQ,
              dishFilterKey: 'browse-dish-filter',
              onDishFilterQ: "browseDishFilterQ(this.value)",
              onDish: "browseToggleDish('$ID')",
            })}

            <span class="browse-filters__label" style="margin-top:10px;display:block">Author</span>
            <input
              type="text"
              class="browse-filters__author-input"
              placeholder="Type to search authors…"
              data-focus-key="browse-author"
              value="${escapeHtml(b.authorQuery)}"
              oninput="browseAuthorAutocomplete(this.value)"
            />
            ${b.authorId ? `
              <button class="toggle-chip toggle-chip--active" style="margin-top:6px" onclick="browseClearAuthor()">
                ${escapeHtml(_browseAuthorName())} ✕
              </button>
            ` : ''}
            ${(!b.authorId && b.authorResults.length) ? `
              <div class="browse-filters__author-suggest">
                ${b.authorResults.map(a => `
                  <button onclick="browsePickAuthor('${escapeHtml(a.userId)}', '${escapeHtml(a.displayName)}')">
                    ${escapeHtml(a.displayName)} <span style="color:#9CA3AF">· ${a.sauceCount}</span>
                  </button>
                `).join('')}
              </div>
            ` : ''}

            ${(b.cuisines.size || b.types.size || (b.dishes && b.dishes.size) || b.authorId) ? `
              <div class="browse-filters__clear-section">
                <hr class="browse-filters__separator" />
                <button class="toggle-chip" onclick="browseClearAllFilters()">Clear all filters ✕</button>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <div class="browse-pageinfo">
          ${b.total > 0
            ? `Showing <strong>${fromIdx}–${toIdx}</strong> of <strong>${b.total}</strong> recipe${b.total === 1 ? '' : 's'}`
            : (b.loading ? 'Loading…' : 'No recipes match your filters.')}
        </div>

        ${b.error ? `<p style="color:#DC2626;padding:8px 0">${escapeHtml(b.error)}</p>` : ''}

        ${b.loading && b.items.length === 0
          ? `<div class="loading-inline"><div class="loading-pot">${potSVG()}</div><p class="loading-text">Saucing…</p></div>`
          : b.items.map(_renderBrowseRow).join('')
        }

        ${b.total > pageSize ? `
          <div class="browse-pager">
            <button class="browse-pager__btn"
                    onclick="browseGoToPage(${b.page - 1})"
                    ${b.page <= 0 || b.loading ? 'disabled' : ''}>
              <i data-lucide="chevron-left"></i> Prev
            </button>
            <span class="browse-pager__label">Page <strong>${currentPage}</strong> of <strong>${totalPages}</strong></span>
            <button class="browse-pager__btn"
                    onclick="browseGoToPage(${b.page + 1})"
                    ${currentPage >= totalPages || b.loading ? 'disabled' : ''}>
              Next <i data-lucide="chevron-right"></i>
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function _browseAuthorName() {
  // Surface the active author's display name; we cache it on the chip click.
  return state.browse._authorName || 'Author';
}

function _renderBrowseRow(row) {
  // Browse rows are lightweight (no ingredients), so missing-ingredient
  // counts surface only in Saucebook. Variant count from the backend is the
  // count under the family root, displayed as root + variants.
  const totalVersions = (row.variantCount || 0) > 0 ? (row.variantCount + 1) : 0;
  const variantBadge = totalVersions >= 2
    ? `<span class="variant-badge" title="${totalVersions} versions in this family"><i data-lucide="git-branch"></i> ${totalVersions}</span>`
    : '';
  const isAdded = !!row.inSaucebook;
  return renderSauceRow(row, {
    variantBadge,
    onClick: `browseOpenRecipe('${escapeHtml(row.id)}')`,
    actionLabel: currentUser ? (isAdded ? 'Added ✓' : '+ Saucebook') : null,
    actionHandler: `event.stopPropagation(); browseAddToSaucebook('${escapeHtml(row.id)}', this)`,
    actionDisabled: isAdded,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

function browseSetQuery(q) {
  state.browse.q = q;
  if (_browseDebounce) clearTimeout(_browseDebounce);
  _browseDebounce = setTimeout(() => browseRunSearch(), 300);
}

function browseRunSearch() {
  state.browse.page = 0;
  state.browse.items = [];
  browseFetch();
}

function browseToggleFilters() {
  state.browse.filtersOpen = !state.browse.filtersOpen;
  render();
}

function browseToggleCuisine(name) {
  if (state.browse.cuisines.has(name)) state.browse.cuisines.delete(name);
  else state.browse.cuisines.add(name);
  state.browse.cuisineFilterQ = '';
  browseRunSearch();
}

function browseToggleType(value) {
  if (state.browse.types.has(value)) state.browse.types.delete(value);
  else state.browse.types.add(value);
  browseRunSearch();
}

function browseToggleDish(id) {
  if (!state.browse.dishes) state.browse.dishes = new Set();
  if (state.browse.dishes.has(id)) state.browse.dishes.delete(id);
  else state.browse.dishes.add(id);
  state.browse.dishFilterQ = '';
  browseRunSearch();
}

function browseCuisineFilterQ(q) {
  state.browse.cuisineFilterQ = q;
  render();
}

function browseDishFilterQ(q) {
  state.browse.dishFilterQ = q;
  render();
}

function browseAuthorAutocomplete(q) {
  // Only stash the query in state — don't re-render on every keystroke. The
  // recipe list is filtered by `state.browse.authorId`, which is set ONLY
  // when the user picks an author from the dropdown (browsePickAuthor),
  // never while typing. The debounced fetch below renders once when fresh
  // suggestions land. This keeps focus stable in the input and avoids
  // re-rendering the row list while the user is still typing.
  state.browse.authorQuery = q;
  if (_authorDebounce) clearTimeout(_authorDebounce);
  _authorDebounce = setTimeout(async () => {
    try {
      state.browse.authorResults = await api.listAuthors(q);
    } catch (_) { state.browse.authorResults = []; }
    render();
  }, 200);
}

function browsePickAuthor(userId, displayName) {
  state.browse.authorId = userId;
  state.browse._authorName = displayName;
  state.browse.authorResults = [];
  state.browse.authorQuery = '';
  browseRunSearch();
}

function browseClearAuthor() {
  state.browse.authorId = null;
  state.browse._authorName = null;
  browseRunSearch();
}

function browseClearAllFilters() {
  const b = state.browse;
  b.cuisines = new Set();
  b.cuisineFilterQ = '';
  b.types = new Set();
  b.dishes = new Set();
  b.dishFilterQ = '';
  b.authorId = null;
  b._authorName = null;
  b.authorQuery = '';
  b.authorResults = [];
  b.q = '';
  browseRunSearch();
}

// Discrete page navigation. The Browse view used to grow a single list with
// "Load more"; the user feedback is that page-by-page navigation is clearer
// once there are dozens of recipes (and the total-count chip above tells
// you how many pages there are total).
async function browseGoToPage(page) {
  const pageSize = state.browse.pageSize || 20;
  const totalPages = Math.max(1, Math.ceil((state.browse.total || 0) / pageSize));
  const clamped = Math.max(0, Math.min(page, totalPages - 1));
  if (clamped === state.browse.page && state.browse.items.length > 0) return;
  state.browse.page = clamped;
  await browseFetch();
  // Scroll the list back to the top when changing pages so the user sees
  // page 1 of the new chunk, not the bottom of the previous page's tail.
  const body = document.querySelector('#app .scroll-body');
  if (body) body.scrollTop = 0;
}

async function browseFetch() {
  const b = state.browse;
  b.loading = true;
  b.error = null;
  render();
  try {
    const params = {
      q: b.q,
      cuisines: [...(b.cuisines || [])],
      types: [...(b.types || [])],
      dishes: [...(b.dishes || [])],
      author: b.authorId,
      limit: b.pageSize,
      offset: b.page * b.pageSize,
    };
    const res = await api.browseSauces(params);
    b.items = res.items;
    b.total = res.total;
  } catch (err) {
    b.error = err?.message || 'Browse fetch failed';
  } finally {
    b.loading = false;
    render();
  }
}

async function browseAddToSaucebook(sauceId, btnEl) {
  if (!currentUser) { openAuthModal(); return; }
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Adding…'; }
  try {
    await api.addToSaucebook(sauceId);
    // Mark the row in-place so the user sees the success state without a
    // full re-render flicker; refresh saucebook + pantry in the background
    // (pantry is derived from saucebook ingredients).
    const row = state.browse.items.find(i => i.id === sauceId);
    if (row) row.inSaucebook = true;
    refreshSaucebookAndPantry();
    render();
  } catch (err) {
    console.error('[sauceboss] addToSaucebook failed:', err);
    state.browse.error = err?.message || 'Add failed';
    render();
  }
}

function browseOpenRecipe(sauceId) {
  // Reuse the standalone recipe view: stash the family in state and navigate.
  const row = state.browse.items.find(i => i.id === sauceId);
  if (!row) return;
  // Browse rows are lightweight (no steps/ingredients). Defer to the existing
  // all-sauces path: load the full envelope, then navigate to the recipe view.
  state.loading = 'Loading recipe…';
  render();
  api.allSauces().then(all => {
    state.loading = null;
    const family = all.filter(s => s.id === sauceId || s.parentSauceId === sauceId);
    const found = family.find(s => s.id === sauceId) || all.find(s => s.id === sauceId);
    if (!found) { state.loading = null; render(); return; }
    state.selectedSauce = found;
    state.servings = found.defaultServings || 2;
    state.selectedSauceFamily = family.length ? family : [found];
    state.hiddenPieSlices = {};
    state.selectedItem = null;
    state.meal = { item: null, prep: null, sauce: null };
    state.recipeReturnTo = 'tab-shell';
    navigate('recipe');
  }).catch(err => {
    state.loading = null;
    state.browse.error = err?.message || 'Recipe load failed';
    render();
  });
}

// Trigger an initial fetch when the user lands on the Browse tab. Called
// explicitly from setActiveTab + init.js — replaces the previous
// MutationObserver lazy-load, which fired ensure() on every #app mutation
// and could loop into repeated browseFetch() calls when a filter happened
// to return zero items (each empty result triggered another render →
// observer → ensure → browseFetch cycle, freezing the tab).
function browseEnsureLoaded() {
  const b = state.browse;
  if (!b || b.loading || b.items.length > 0 || b.error) return;
  browseFetch();
}
