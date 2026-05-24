'use strict';

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Backend stores ingredient names lowercased ("jalapeño", "olive oil");
// surfaces capitalize the first letter of each word for display so users
// see "Jalapeño" / "Olive Oil". Use anywhere `ing.name` is rendered.
function capitalizeIngredient(name) {
  if (!name) return '';
  return String(name)
    .split(/(\s+)/)
    .map(t => (t.trim() ? t.charAt(0).toUpperCase() + t.slice(1) : t))
    .join('');
}

// `renderEmoji`, `flagEmojiToCode`, and `FLAG_SUPPORTED` were extracted to
// `ui/emoji.js` in the 2026-05-24 carve-out. The script-tag load order in
// index.html keeps them available as globals before any caller fires.

// ─── API fetch helpers ────────────────────────────────────────────────────────
const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:8000';

fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: window.APP_CONFIG?.project || 'sauceboss', event: 'app_open' })
}).catch(() => {});

// One API client for the whole web app, sourced from shared/api.js so native
// and web hit the same endpoints with the same auth + error-shape handling.
// The `getAuthToken` arrow reads `session` on each call so it picks up the
// latest Supabase session without needing to rebuild the client on sign-in.
const api = SBShared.api.makeApi({
  fetchFn: window.fetch.bind(window),
  getAuthToken: () => session?.access_token || null,
  baseUrl: API,
});

// Existing call sites use these names; the bodies just delegate to `api` now.
// Keeping the shims means no churn across the 60-odd callers in init.js,
// settings.js, builder.js, sauces.js, and auth.js.
const fetchInitialLoad         = () => api.initialLoad();
const fetchIngredientCategories = () => api.ingredientCategories();
const fetchSubstitutions       = () => api.substitutions();
const fetchUnits               = () => api.units();
const fetchIngredients         = (q, limit) => api.ingredients(q, limit);
const importRecipeFromUrl      = (url) => api.importRecipeFromUrl(url);
const importRecipeFromText     = (text, sourceUrl, contentType) => api.importRecipeFromText(text, sourceUrl, contentType);
const createSauce              = (data) => api.createSauce(data);
const updateSauce              = (id, data) => api.updateSauce(id, data);
const fetchAllSauces           = () => api.allSauces();
const fetchAdminSauces         = () => api.adminListSauces();
const fetchItems               = () => api.allItems();
const adminCreateItem          = (data) => api.createItem(data);
const adminUpdateItem          = (id, data) => api.updateItem(id, data);
const adminDeleteItem          = (id) => api.deleteItem(id);
const deleteAdminSauce         = (id) => api.adminDeleteSauce(id);
// Backend validates `created_by == current user OR is_admin` — same endpoint
// used by the manager when a logged-in non-admin removes their own recipe.
const deleteSauceOwned         = (id) => api.deleteSauce(id);
const fetchIngredientsWithUsage = () => api.listIngredientsWithUsage();
const adminCreateIngredient    = (payload) => api.createIngredient(payload);
const adminUpdateIngredient    = (id, payload) => api.updateIngredient(id, payload);
const adminDeleteIngredient    = (id) => api.deleteIngredient(id);
const adminMergeIngredients    = (keepId, mergeIds) => api.mergeIngredients(keepId, mergeIds);
const adminAssignSauceVariants = (parentId, sauceIds) => api.assignSauceVariants(parentId, sauceIds);
const fetchProfile             = () => api.getProfile();
const createProfile            = (displayName) => api.upsertProfile(displayName);
const becomeAdmin              = (adminKey) => api.becomeAdmin(adminKey);

// `availableCuisines` / `saucebookCuisines` live in `domain/cuisine.js` —
// extracted in the 2026-05-24 carve-out.

// Unit conversion (toTsp, cumulativeStepTsp, tspToDisplay, convertUnit,
// formatAmount, scaleAmount) lives in shared/units.js and is published to
// `window` by shared-bridge.js. The web-only `prepareItems` below stays in
// this file because it pulls servings + unitSystem off the global state,
// while the shared version takes them as parameters.

// Pure logic lives in shared/ and reaches us via shared-bridge.js. Functions
// below are state-injecting shims: their only job is to pass the relevant
// slice of the global `state` (or `currentUser`) into the shared helper.
// Identical-signature helpers (ingColor, polarToCartesian, arcPath,
// levenshtein, buildSauceFamilies, withIngredientNames) are exposed directly
// on `window` by the bridge — call sites use them unchanged.

// Sauce-side state shims (isSauceAvailable, missingSauceIngredients,
// getCurrentSauceContext) live in `domain/sauce.js`. Ingredient-side
// shims (getSubstitutionText, getIngredientFrequencies,
// groupIngredientsByCategory, fuzzyMatchIngredients, isKnownIngredient,
// classifyIngredientLocal) live in `domain/ingredient.js`. Both extracted
// in the 2026-05-24 carve-out.

function togglePieSlice(stepIndex, name) {
  if (!state.hiddenPieSlices[stepIndex]) state.hiddenPieSlices[stepIndex] = new Set();
  const set = state.hiddenPieSlices[stepIndex];
  if (set.has(name)) set.delete(name); else set.add(name);
  render();
}

function buildPieChart(items, size = 160, stepIndex) {
  const hidden = stepIndex != null && state.hiddenPieSlices[stepIndex] || null;
  const visible = hidden ? items.filter(i => !hidden.has(i.name)) : items;
  const total = visible.reduce((s, item) => s + toTsp(item.amount, item.unit), 0);
  const cx = size / 2, cy = size / 2, r = size / 2 - 6;
  if (total === 0) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="pie-chart"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#E5E7EB" stroke="#FFF8F0" stroke-width="2"/></svg>`;
  if (visible.length === 1) {
    const origIdx = items.indexOf(visible[0]);
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="pie-chart"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${ingColor(visible[0].name, origIdx)}" stroke="#FFF8F0" stroke-width="2"/></svg>`;
  }
  let currentAngle = 0, svgPaths = '';
  visible.forEach(item => {
    const origIdx = items.indexOf(item);
    const pct = toTsp(item.amount, item.unit) / total;
    const sweep = pct * 360;
    svgPaths += `<path d="${arcPath(cx, cy, r, currentAngle, currentAngle + sweep)}" fill="${ingColor(item.name, origIdx)}" stroke="#FFF8F0" stroke-width="2"/>`;
    currentAngle += sweep;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="pie-chart">${svgPaths}</svg>`;
}

function buildLegend(items, stepIndex) {
  const hidden = stepIndex != null && state.hiddenPieSlices[stepIndex] || null;
  const visibleItems = hidden ? items.filter(i => !hidden.has(i.name)) : items;
  const total = visibleItems.reduce((s, i) => s + toTsp(i.amount, i.unit), 0);
  return items.map((item, idx) => {
    const isQualitative = QUALITATIVE_UNITS.has(item.unit);
    const color = ingColor(item.name, idx);
    const isDisabled = state.disabledIngredients.has(item.name);
    const isHidden = hidden ? hidden.has(item.name) : false;
    const sub = isDisabled ? getSubstitutionText(item.name) : '';
    const safeName = item.name.replace(/'/g, "\\'");
    const clickAttr = stepIndex != null ? ` onclick="togglePieSlice(${stepIndex}, '${safeName}')"` : '';
    const amountCell = isQualitative
      ? `<span class="legend-amount legend-amount-qualitative">${item.unit}</span>`
      : (() => {
          const converted = convertUnit(item.amount, item.unit, state.unitSystem, item);
          return `<span class="legend-amount">${formatAmount(converted.amount)} ${converted.unit}</span>`;
        })();
    const pctCell = isQualitative || isHidden
      ? '<span class="legend-pct"></span>'
      : `<span class="legend-pct">${total ? Math.round((toTsp(item.amount, item.unit) / total) * 100) : 0}%</span>`;
    // We deliberately don't apply .legend-disabled here even when the user
    // is out of an ingredient — striking out names on the recipe page reads
    // as "we can't use this", which is confusing while cooking. The
    // pantry/saucebook surface remains the place to track availability.
    const cls = ['legend-item', isHidden && 'legend-hidden'].filter(Boolean).join(' ');
    const modPrefix = item.modifier ? `${item.modifier} ` : '';
    return `<div class="${cls}"${clickAttr}>
      <span class="legend-swatch" style="background:${color}"></span>
      <div class="legend-name-wrap">
        <span class="legend-name">${modPrefix}${item.name}</span>
        ${sub ? `<span class="sub-hint">try ${sub}</span>` : ''}
      </div>
      ${amountCell}
      ${pctCell}
    </div>`;
  }).join('');
}

function prepareItems(items) {
  const base = state.selectedSauce?.defaultServings || 2;
  const factor = state.servings / base;
  return items.map(item => {
    const scaled = scaleAmount(item.amount, state.servings, base);
    const scaledItem = {
      ...item,
      amount: scaled,
      canonicalMl: item.canonicalMl != null ? item.canonicalMl * factor : null,
      canonicalG:  item.canonicalG  != null ? item.canonicalG  * factor : null,
    };
    const converted = convertUnit(scaled, item.unit, state.unitSystem, scaledItem);
    return {
      name: item.name,
      amount: converted.amount,
      unit: converted.unit,
      modifier: item.modifier || null,
      canonicalMl: scaledItem.canonicalMl,
      canonicalG: scaledItem.canonicalG,
    };
  });
}

// `renderRecipeControls`, `renderRecipeIngredientPanel`, `renderRecipeStep`,
// `renderVariantSwitcher`, and `renderItemPrepBlock` were extracted to
// `ui/recipe-views.js` in the 2026-05-24 carve-out. They depend on the data
// utilities below (aggregateSauceIngredients, prepareItems, etc.) which stay
// here.

// Sum a sauce's per-step ingredients into a single shopping-list view,
// keyed by (name, unit) so different units of the same ingredient stay
// separate. Canonical ml/g totals are summed where present so the metric
// conversion matches what the per-step legend would show.
function aggregateSauceIngredients(sauce) {
  const buckets = new Map();
  for (const step of (sauce.steps || [])) {
    for (const ing of (step.ingredients || [])) {
      // Modifier participates in the key so "fresh thyme" and "dried thyme"
      // stay as distinct shopping-list lines.
      const key = `${ing.name}|${ing.unit}|${ing.modifier || ''}`;
      const prev = buckets.get(key);
      if (prev) {
        prev.amount += Number(ing.amount) || 0;
        if (ing.canonicalMl != null) prev.canonicalMl = (prev.canonicalMl || 0) + ing.canonicalMl;
        if (ing.canonicalG != null)  prev.canonicalG  = (prev.canonicalG  || 0) + ing.canonicalG;
      } else {
        buckets.set(key, {
          name: ing.name,
          amount: Number(ing.amount) || 0,
          unit: ing.unit,
          modifier: ing.modifier || null,
          canonicalMl: ing.canonicalMl != null ? ing.canonicalMl : null,
          canonicalG:  ing.canonicalG  != null ? ing.canonicalG  : null,
        });
      }
    }
  }
  return [...buckets.values()];
}

function toggleRecipeIngredients() {
  state.recipeIngredientsOpen = !state.recipeIngredientsOpen;
  render();
}

// `renderSauceRow` → `ui/sauce-row.js`. `renderAccordionGroup` →
// `ui/accordion-group.js`. `renderFilterChips` → `ui/filter-chips.js`.
// All extracted in the 2026-05-24 carve-out.

// `sauceMissingCount` lives in `domain/sauce.js`.

// ─── Navigation ───────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');

  // Capture focus state BEFORE the innerHTML rebuild so we can restore it
  // afterwards. The whole-tree replace on every render would otherwise blur
  // any input the user is typing into (search bars, author autocomplete).
  // We key on a stable `data-focus-key` attribute on each input that wants
  // focus persistence; selection range is captured for inputs/textareas.
  const focused = document.activeElement;
  let focusKey = null, selStart = null, selEnd = null;
  if (focused && focused.dataset && focused.dataset.focusKey && app.contains(focused)) {
    focusKey = focused.dataset.focusKey;
    if (typeof focused.selectionStart === 'number') {
      try { selStart = focused.selectionStart; selEnd = focused.selectionEnd; } catch (_) {}
    }
  }

  switch (state.screen) {
    case 'tab-shell':              app.innerHTML = renderActiveTab(); break;
    case 'meal-category':          app.innerHTML = renderMealCategory(); break;
    case 'meal-subtype':           app.innerHTML = renderMealSubtype(); break;
    case 'sauce-selector':         app.innerHTML = renderSauceSelector(); break;
    case 'recipe':                 app.innerHTML = renderRecipe(); break;
    case 'builder-source':           app.innerHTML = renderBuilderSource(); break;
    case 'builder-info':             app.innerHTML = renderBuilderInfo(); break;
    case 'builder-instructions':     app.innerHTML = renderBuilderInstructions(); break;
    case 'builder-pairing':          app.innerHTML = renderBuilderPairing(); break;
    case 'builder-review':           app.innerHTML = renderBuilderReview(); break;
    case 'settings':               app.innerHTML = renderSettings(); break;
    case 'admin':                  app.innerHTML = renderAdmin(); break;
  }
  // Show inline animated pot logo inside the current screen's body
  if (state.loading) {
    const scrollBody = app.querySelector('.scroll-body');
    if (scrollBody) {
      scrollBody.innerHTML = `
        <div class="loading-inline">
          <div class="loading-pot">${potSVG()}</div>
          <p class="loading-text">${state.loading}</p>
        </div>`;
    }
  }
  // Bottom nav re-renders on every tick so it reflects activeTab + auth state.
  if (typeof renderBottomNav === 'function') renderBottomNav();
  _initIcons();

  // Restore focus + caret on the rebuilt input matching the captured key.
  if (focusKey) {
    const next = app.querySelector(`[data-focus-key="${focusKey}"]`);
    if (next) {
      try { next.focus(); } catch (_) {}
      if (selStart != null && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }
  }
}

// Tab-shell dispatcher. Each tab renderer is defined in its own module
// (saucebook.js / browse.js / pantry.js); this is just the switch.
function renderActiveTab() {
  switch (state.activeTab) {
    case 'saucebook':
      if (!currentUser) return _tabLockedShell('saucebook');
      return typeof renderSaucebook === 'function' ? renderSaucebook() : _tabPlaceholder('Saucebook');
    case 'browse':
      return typeof renderBrowse === 'function' ? renderBrowse() : _tabPlaceholder('Browse');
    case 'pantry':
      if (!currentUser) return _tabLockedShell('pantry');
      return typeof renderPantry === 'function' ? renderPantry() : _tabPlaceholder('Pantry');
    default:
      return _tabPlaceholder('Sauceboss');
  }
}

function _tabLockedShell(label) {
  return `
    <div class="screen-wrap">
      <div class="scroll-body">
        <div class="tab-locked">
          <i data-lucide="lock"></i>
          <h2>Sign in to use ${label}</h2>
          <p>Create an account to save recipes to your saucebook and track what's in your pantry.</p>
          <button class="btn-primary" onclick="openAuthModal()">Sign in</button>
        </div>
      </div>
    </div>`;
}

function _tabPlaceholder(label) {
  return `<div class="screen-wrap"><div class="scroll-body"><p style="padding:2rem;text-align:center;color:var(--text-muted)">${label} loading…</p></div></div>`;
}

// Load cuisine + dish + unit lookups for the filter panels (non-blocking, fire once).
async function loadFilterLookups() {
  // Load each independently so one failure doesn't block the other.
  try {
    state.allCuisines = await api.cuisines();
  } catch (err) {
    console.warn('[sauceboss] cuisine lookup failed, using hardcoded list', err);
  }
  try {
    state.allFilterDishes = await api.filterDishes();
  } catch (err) {
    console.warn('[sauceboss] dish lookup failed', err);
  }
  try {
    const rows = await api.units();
    if (rows.length) {
      state.allUnits = rows;
      // Overwrite the hardcoded globals with DB-driven values so every
      // consumer (builder dropdown, pie-chart gating, ingredient validation)
      // picks up units the backend actually knows about.
      window.UNITS = rows.map(u => u.abbreviation);
      window.QUALITATIVE_UNITS = new Set(
        rows.filter(u => !u.quantifiable).map(u => u.abbreviation)
      );
    }
  } catch (err) {
    console.warn('[sauceboss] unit lookup failed, using hardcoded list', err);
  }
  try {
    const mods = await api.ingredientModifiers();
    // Drives the per-ingredient prep dropdown in the recipe builder. The
    // backend seeds this list (sauceboss_ingredient_modifier) so adding a
    // word like "blanched" is a SQL insert, not a code change.
    state.ingredientModifiers = mods;
    window.INGREDIENT_MODIFIERS = mods;
  } catch (err) {
    console.warn('[sauceboss] ingredient modifier lookup failed', err);
  }
  render();
}

// Re-fetch the saucebook + pantry in parallel and re-render. Called after
// any change to saucebook membership (add from Browse, save from builder,
// remove via the recipe view) since the pantry surface is derived from
// saucebook ingredients — adding a recipe with new ingredients should make
// them appear in Pantry, removing the last recipe that uses an ingredient
// should make it disappear, and so on.
async function refreshSaucebookAndPantry() {
  if (!currentUser) return;
  try {
    const [sb, pantry] = await Promise.all([
      api.listSaucebook(),
      api.getPantry(),
    ]);
    state.saucebook = sb;
    state.pantry.ingredients = pantry.ingredients || [];
    state.pantry.missing = new Set((pantry.ingredients || []).filter(i => i.missing).map(i => i.ingredientId));
    state.pantry._loaded = true;
    hydrateIngredientCategoriesFromPantry(state.pantry.ingredients);
    syncDisabledFromPantry();
    render();
  } catch (err) {
    console.warn('[sauceboss] refreshSaucebookAndPantry failed:', err);
  }
}

// Each pantry row now carries its `category` from sauceboss_ingredient.category
// (migration 015), so the pantry tab can render in one round-trip. The same
// per-row data is enough to populate state.ingredientCategories for the
// meal-builder filter panel — no separate /ingredient-categories call needed
// on the pantry path. The recipe builder still calls ensureBuilderRefData()
// for the global map covering ingredients outside the saucebook.
function hydrateIngredientCategoriesFromPantry(ingredients) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) return;
  const cats = state.ingredientCategories || {};
  for (const ing of ingredients) {
    if (ing && ing.category && ing.name) {
      cats[ing.name.toLowerCase()] = ing.category;
    }
  }
  state.ingredientCategories = cats;
}

// Refresh state.disabledIngredients from state.pantry. This is the bridge
// between the ingredientId-keyed pantry and the name-keyed filter helpers.
function syncDisabledFromPantry() {
  const out = new Set();
  for (const ing of state.pantry.ingredients || []) {
    if (ing.missing && ing.name) out.add(ing.name);
  }
  state.disabledIngredients = out;
}

// Toggle a single ingredientId in the user's pantry-missing set, persist to /pantry
// in the background, and re-render so the saucebook ingredient filter and the
// Pantry tab stay in sync. The optimistic update lets the UI feel instant;
// on error we revert.
async function togglePantryMissing(ingredientId) {
  if (!currentUser || !ingredientId) return;
  const missing = state.pantry.missing;
  const wasMissing = missing.has(ingredientId);
  if (wasMissing) missing.delete(ingredientId);
  else missing.add(ingredientId);
  for (const ing of state.pantry.ingredients) {
    if (ing.ingredientId === ingredientId) ing.missing = !wasMissing;
  }
  syncDisabledFromPantry();
  render();
  try {
    const data = await api.setPantryMissing([...missing]);
    state.pantry.ingredients = data.ingredients;
    syncDisabledFromPantry();
  } catch (err) {
    console.error('[sauceboss] pantry sync failed', err);
    if (wasMissing) missing.add(ingredientId); else missing.delete(ingredientId);
    for (const ing of state.pantry.ingredients) {
      if (ing.ingredientId === ingredientId) ing.missing = wasMissing;
    }
    syncDisabledFromPantry();
    render();
  }
}

// ─── Lazy reference-data loaders ────────────────────────────────────────────
// These slices used to fire on every boot. They're now loaded on demand the
// first time a feature that needs them opens (meal-builder, recipe-builder,
// Pantry tab). Each helper is idempotent + concurrency-safe via an in-flight
// promise cache so multiple call sites awaiting it share one fetch.

let _itemListsPromise = null;
let _builderRefDataPromise = null;
let _ingredientCategoriesPromise = null;

// /initial-load → state.carbs / state.proteins / state.saladBases.
// Needed for the meal-builder dish picker.
function ensureItemLists() {
  if (state.carbs.length || state.proteins.length || state.saladBases.length) {
    return Promise.resolve();
  }
  if (_itemListsPromise) return _itemListsPromise;
  _itemListsPromise = fetchInitialLoad()
    .then(({ carbs, proteins, saladBases }) => {
      state.carbs = carbs || [];
      state.proteins = proteins || [];
      state.saladBases = saladBases || [];
    })
    .catch(err => {
      console.warn('[sauceboss] initial-load failed:', err);
      _itemListsPromise = null;
    });
  return _itemListsPromise;
}

// /ingredient-categories + /substitutions. Needed by both the meal-builder
// (filter + substitution hints) and the recipe-builder (autocomplete +
// classify chip).
function ensureBuilderRefData() {
  if (_hasBuilderRefData()) return Promise.resolve();
  if (_builderRefDataPromise) return _builderRefDataPromise;
  _builderRefDataPromise = Promise.all([
    fetchIngredientCategories().catch(() => ({})),
    fetchSubstitutions().catch(() => ({})),
  ]).then(([categories, subs]) => {
    state.ingredientCategories = categories && typeof categories === 'object' ? categories : {};
    state.substitutions = subs && typeof subs === 'object' ? subs : {};
  });
  return _builderRefDataPromise;
}

function _hasBuilderRefData() {
  return Object.keys(state.ingredientCategories || {}).length > 0
      && Object.keys(state.substitutions || {}).length > 0;
}

// Lazy categories-only load for the Pantry tab (groups ingredients by
// category). Pantry tolerates rendering with "Uncategorized" while this
// fetch is in flight, so the caller doesn't have to await.
function ensureIngredientCategories() {
  if (Object.keys(state.ingredientCategories || {}).length > 0) {
    return Promise.resolve();
  }
  if (_ingredientCategoriesPromise) return _ingredientCategoriesPromise;
  _ingredientCategoriesPromise = fetchIngredientCategories()
    .then(categories => {
      state.ingredientCategories = categories && typeof categories === 'object' ? categories : {};
      render();
    })
    .catch(err => {
      console.warn('[sauceboss] ingredient-categories failed:', err);
      _ingredientCategoriesPromise = null;
    });
  return _ingredientCategoriesPromise;
}

// Show the inline pot loader on the current screen while `task` is in
// flight. Used by the meal-builder / recipe-builder open paths so the user
// sees feedback when the lazy reference data hasn't been fetched yet.
async function withInlineLoader(task, label = 'Saucing') {
  state.loading = label;
  render();
  try {
    await task;
  } finally {
    state.loading = null;
    render();
  }
}

function toggleEditMode() {
  if (!currentUser) return;
  state.editMode = !state.editMode;
  try { sessionStorage.setItem('sb_edit_mode', state.editMode ? '1' : '0'); } catch (_) {}
  render();
}

function setEditMode(on) {
  state.editMode = !!on && !!currentUser;
  try { sessionStorage.setItem('sb_edit_mode', state.editMode ? '1' : '0'); } catch (_) {}
  render();
}

function navigate(screen, opts = {}) {
  const { push = true, replace = false, path } = opts;
  state.screen = screen;
  const histState = { screen, sb: true };
  // `path` switches the URL from the default `#screen` fragment to a real
  // pathname (e.g. `/sauce/<id>` for shareable recipe permalinks). Vercel
  // rewrites these back to `index.html` so the SPA still boots.
  const url = path || ('#' + screen);
  if (replace) {
    history.replaceState(histState, '', url);
  } else if (push) {
    history.pushState(histState, '', url);
  }
  render();
}

function _initIcons() {
  if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
}

// Transient bottom-center toast. Imperative on purpose — doesn't go through
// the render() cycle so it can fire from async callbacks without races.
function showToast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--visible'));
  setTimeout(() => {
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 250);
  }, 1800);
}

// Initials helper — kept in sync with boardgame-buddy/web/helpers.js so any
// avatar bubble across vibelab apps derives "JS" / "Mary" the same way.
function computeInitials(name) {
  const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

// `renderAppHeader` and `renderHeaderAuthSlot` live in `ui/app-header.js` —
// extracted in the 2026-05-24 carve-out. They rely on `computeInitials`
// above and on the `currentUser` / `supabaseClient` globals (auth.js).

