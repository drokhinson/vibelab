'use strict';

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Flag emoji fallback ─────────────────────────────────────────────────────
const FLAG_SUPPORTED = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '32px Arial';
    const flagW = ctx.measureText('\u{1F1EB}\u{1F1F7}').width; // 🇫🇷
    const charW = ctx.measureText('FR').width;
    return flagW !== charW;
  } catch { return true; }
})();

function flagEmojiToCode(emoji) {
  const codePoints = [...emoji].map(c => c.codePointAt(0));
  if (codePoints.length === 2 && codePoints.every(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF)) {
    return String.fromCharCode(codePoints[0] - 0x1F1E6 + 65, codePoints[1] - 0x1F1E6 + 65).toLowerCase();
  }
  return null;
}

function renderEmoji(emoji) {
  if (FLAG_SUPPORTED) return emoji;
  const code = flagEmojiToCode(emoji);
  if (code) return `<img src="https://flagcdn.com/w40/${code}.png" alt="${emoji}" class="flag-img">`;
  return emoji;
}

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
// settings.js, items.js, builder.js, sauces.js, and auth.js.
const fetchInitialLoad         = () => api.initialLoad();
const fetchItemLoad            = (id) => api.itemLoad(id);
const fetchIngredientCategories = () => api.ingredientCategories();
const fetchSubstitutions       = () => api.substitutions();
const fetchUnits               = () => api.units();
const fetchFoods               = (q, limit) => api.foods(q, limit);
const importRecipeFromUrl      = (url) => api.importRecipeFromUrl(url);
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
const fetchFoodsWithUsage      = () => api.listFoodsWithUsage();
const adminCreateFood          = (payload) => api.createFood(payload);
const adminUpdateFood          = (id, payload) => api.updateFood(id, payload);
const adminDeleteFood          = (id) => api.deleteFood(id);
const adminMergeFoods          = (keepId, mergeIds) => api.mergeFoods(keepId, mergeIds);
const adminAssignSauceVariants = (parentId, sauceIds) => api.assignSauceVariants(parentId, sauceIds);
const fetchProfile             = () => api.getProfile();
const createProfile            = (displayName) => api.upsertProfile(displayName);
const becomeAdmin              = (adminKey) => api.becomeAdmin(adminKey);

function availableCuisines() {
  const seen = new Map();
  for (const c of CUISINES) seen.set(c.name, c.emoji);
  for (const s of (state.adminSauces || [])) {
    if (s.cuisine && !seen.has(s.cuisine)) seen.set(s.cuisine, s.cuisineEmoji || '🍽');
  }
  return [...seen].map(([name, emoji]) => ({ name, emoji }));
}

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

function isSauceAvailable(sauce) {
  return SBShared.filter.isSauceAvailable(sauce, state.disabledIngredients);
}

function missingSauceIngredients(sauce) {
  return SBShared.filter.missingSauceIngredients(sauce, state.disabledIngredients);
}

function getSubstitutionText(ingredientName) {
  return SBShared.filter.getSubstitutionText(ingredientName, state.substitutions);
}

function getCurrentSauceContext() {
  return { sauces: state.saucesForCurrentItem, allIngredients: state.allIngredients };
}

function getIngredientFrequencies() {
  return SBShared.filter.getIngredientFrequencies(state.saucesForCurrentItem);
}

function groupIngredientsByCategory() {
  return SBShared.filter.groupIngredientsByCategory({
    sauces: state.saucesForCurrentItem,
    allIngredients: state.allIngredients,
    ingredientCategories: state.ingredientCategories,
  });
}

function fuzzyMatchIngredients(query) {
  return SBShared.fuzzy.fuzzyMatchIngredients(query, state.ingredientCategories);
}

function isKnownIngredient(name) {
  return SBShared.fuzzy.isKnownIngredient(name, state.ingredientCategories);
}

async function classifyIngredient(name, category) {
  state.ingredientCategories[name.trim().toLowerCase()] = category;
  fetch(`${API}/api/v1/sauceboss/ingredient-categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientName: name.trim(), category }),
  }).catch(() => {});
}

function buildPieChart(items, size = 160) {
  const total = items.reduce((s, item) => s + toTsp(item.amount, item.unit), 0);
  if (total === 0) return '';
  const cx = size / 2, cy = size / 2, r = size / 2 - 6;
  if (items.length === 1) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="pie-chart"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${ingColor(items[0].name, 0)}" stroke="#FFF8F0" stroke-width="2"/></svg>`;
  }
  let currentAngle = 0, svgPaths = '';
  items.forEach((item, idx) => {
    const pct = toTsp(item.amount, item.unit) / total;
    const sweep = pct * 360;
    svgPaths += `<path d="${arcPath(cx, cy, r, currentAngle, currentAngle + sweep)}" fill="${ingColor(item.name, idx)}" stroke="#FFF8F0" stroke-width="2"/>`;
    currentAngle += sweep;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="pie-chart">${svgPaths}</svg>`;
}

function buildLegend(items) {
  const total = items.reduce((s, i) => s + toTsp(i.amount, i.unit), 0);
  return items.map((item, idx) => {
    const isQualitative = item.unit === 'to taste';
    const color = ingColor(item.name, idx);
    const isDisabled = state.disabledIngredients.has(item.name);
    const sub = isDisabled ? getSubstitutionText(item.name) : '';
    const amountCell = isQualitative
      ? '<span class="legend-amount legend-amount-qualitative">to taste</span>'
      : (() => {
          const converted = convertUnit(item.amount, item.unit, state.unitSystem, item);
          return `<span class="legend-amount">${formatAmount(converted.amount)} ${converted.unit}</span>`;
        })();
    const pctCell = isQualitative
      ? '<span class="legend-pct"></span>'
      : `<span class="legend-pct">${Math.round((toTsp(item.amount, item.unit) / total) * 100)}%</span>`;
    return `<div class="legend-item${isDisabled ? ' legend-disabled' : ''}">
      <span class="legend-swatch" style="background:${color}"></span>
      <div class="legend-name-wrap">
        <span class="legend-name">${item.name}</span>
        ${sub ? `<span class="sub-hint">try ${sub}</span>` : ''}
      </div>
      ${amountCell}
      ${pctCell}
    </div>`;
  }).join('');
}

function prepareItems(items) {
  const factor = state.servings / 2;        // base recipes are for 2 people
  return items.map(item => {
    const scaled = scaleAmount(item.amount, state.servings);
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
      canonicalMl: scaledItem.canonicalMl,
      canonicalG: scaledItem.canonicalG,
    };
  });
}

// ─── Shared recipe-row markup ────────────────────────────────────────────────
// Used by Browse + Saucebook so the two list views are visually identical.
// `sauce` is a sauce envelope (ingredients optional — Browse rows are
// lightweight and skip them); `opts` controls per-tab affordances:
//   variantCount    — number to render as a "N variants" chip (omit if 0/1)
//   actionLabel     — text for the right-side action button (e.g. "+ Saucebook").
//                     If null, the action button is omitted (saucebook rows).
//   actionHandler   — JS expression for the button's onclick (already escapes
//                     event.stopPropagation() and any other plumbing).
//   actionDisabled  — render the button in the green "Added" pill state.
//   onClick         — JS expression for the row's onclick (e.g. opening the
//                     recipe view).
//   missingCount    — number of pantry-missing ingredients in this sauce.
//                     Renders a "Missing N" badge that does NOT block the click.
function renderRecipeRow(sauce, opts = {}) {
  const type = SAUCE_TYPES.find(t => t.value === sauce.sauceType);
  const typeLabel = type ? type.label : sauce.sauceType;
  const author = sauce.authorName || (sauce.createdBy ? 'Unknown' : 'SauceBoss');
  const variantTag = (opts.variantCount && opts.variantCount > 1)
    ? `<span class="recipe-row__variants">${opts.variantCount} variants</span>`
    : '';
  const missingTag = (opts.missingCount && opts.missingCount > 0)
    ? `<span class="recipe-row__missing" title="${opts.missingCount} ingredient${opts.missingCount === 1 ? '' : 's'} missing from your pantry"><i data-lucide="alert-circle"></i> Missing ${opts.missingCount}</span>`
    : '';
  const actionBtn = opts.actionLabel
    ? `<button class="recipe-row__action ${opts.actionDisabled ? 'recipe-row__action--added' : ''}"
                ${opts.actionDisabled ? 'disabled' : ''}
                onclick="${opts.actionHandler || ''}">${opts.actionLabel}</button>`
    : '';
  return `
    <div class="recipe-row" onclick="${opts.onClick || ''}">
      <span class="recipe-row__color" style="background:${sauce.color || '#E85D04'}"></span>
      <div class="recipe-row__main">
        <div class="recipe-row__name">${escapeHtml(sauce.name)}</div>
        <div class="recipe-row__meta">
          <span class="recipe-row__type">${escapeHtml(typeLabel)}</span>
          <span class="recipe-row__author">by ${escapeHtml(author)}</span>
          ${variantTag}
          ${missingTag}
        </div>
      </div>
      ${actionBtn}
    </div>
  `;
}

// Count how many of a sauce's ingredients are flagged missing in the user's
// pantry. Operates on the disabledIngredients name-set so it works the same
// for sauces in the saucebook (full envelope w/ ingredients) and gracefully
// returns 0 for the lightweight Browse rows that don't carry ingredients.
function sauceMissingCount(sauce) {
  if (!sauce || !Array.isArray(sauce.ingredients)) return 0;
  if (!state.disabledIngredients || state.disabledIngredients.size === 0) return 0;
  const seen = new Set();
  let n = 0;
  for (const ing of sauce.ingredients) {
    if (!ing || !ing.name) continue;
    if (seen.has(ing.name)) continue;
    seen.add(ing.name);
    if (state.disabledIngredients.has(ing.name)) n += 1;
  }
  return n;
}

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
    case 'meal-builder':           app.innerHTML = renderMealBuilder(); break;
    case 'meal-category':          app.innerHTML = renderMealCategory ? renderMealCategory() : renderMealBuilder(); break;
    case 'meal-dish':              app.innerHTML = renderMealDish ? renderMealDish() : renderMealBuilder(); break;
    case 'meal-recipe':            app.innerHTML = renderMealRecipe(); break;
    case 'prep-selector':          app.innerHTML = renderPrepSelector(); break;
    case 'sauce-selector':         app.innerHTML = renderSauceSelector(); break;
    case 'recipe':                 app.innerHTML = renderRecipe(); break;
    case 'builder':                app.innerHTML = renderBuilder(); break;
    case 'builder-items':          app.innerHTML = renderBuilderItems(); break;
    case 'builder-review':         app.innerHTML = renderBuilderReview(); break;
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
  return `<div class="screen-wrap"><div class="scroll-body"><p style="padding:2rem;text-align:center;color:#6B7280">${label} loading…</p></div></div>`;
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
    state.pantry.missing = new Set((pantry.ingredients || []).filter(i => i.missing).map(i => i.foodId));
    state.pantry._loaded = true;
    syncDisabledFromPantry();
    render();
  } catch (err) {
    console.warn('[sauceboss] refreshSaucebookAndPantry failed:', err);
  }
}

// Refresh state.disabledIngredients from state.pantry. This is the bridge
// between the foodId-keyed pantry and the name-keyed filter helpers.
function syncDisabledFromPantry() {
  const out = new Set();
  for (const ing of state.pantry.ingredients || []) {
    if (ing.missing && ing.name) out.add(ing.name);
  }
  state.disabledIngredients = out;
}

// Toggle a single foodId in the user's pantry-missing set, persist to /pantry
// in the background, and re-render so the saucebook ingredient filter and the
// Pantry tab stay in sync. The optimistic update lets the UI feel instant;
// on error we revert.
async function togglePantryMissing(foodId) {
  if (!currentUser || !foodId) return;
  const missing = state.pantry.missing;
  const wasMissing = missing.has(foodId);
  if (wasMissing) missing.delete(foodId);
  else missing.add(foodId);
  for (const ing of state.pantry.ingredients) {
    if (ing.foodId === foodId) ing.missing = !wasMissing;
  }
  syncDisabledFromPantry();
  render();
  try {
    const data = await api.setPantryMissing([...missing]);
    state.pantry.ingredients = data.ingredients;
    syncDisabledFromPantry();
  } catch (err) {
    console.error('[sauceboss] pantry sync failed', err);
    if (wasMissing) missing.add(foodId); else missing.delete(foodId);
    for (const ing of state.pantry.ingredients) {
      if (ing.foodId === foodId) ing.missing = wasMissing;
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
  const { push = true, replace = false } = opts;
  state.screen = screen;
  const histState = { screen, sb: true };
  const url = '#' + screen;
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

// Initials helper — kept in sync with boardgame-buddy/web/helpers.js so any
// avatar bubble across vibelab apps derives "JS" / "Mary" the same way.
function computeInitials(name) {
  const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

// Top-right slot in the app header. Shows "Sign in" when logged out, an
// avatar pill with display-name initials when logged in.
function renderHeaderAuthSlot() {
  if (!supabaseClient) return '';
  if (!currentUser) {
    return `<button class="auth-signin-btn" onclick="openAuthModal()" title="Sign in" aria-label="Sign in"><i data-lucide="log-in"></i></button>`;
  }
  const name = currentUser.display_name || 'Saucier';
  const initials = computeInitials(name);
  return `
    <details class="auth-pill">
      <summary class="auth-pill__summary" title="${name}">
        <span class="auth-pill__initials">${initials}</span>
        ${currentUser.is_admin ? '<span class="auth-pill__badge" title="Admin">★</span>' : ''}
      </summary>
      <div class="auth-pill__menu" role="menu">
        <p class="auth-pill__name">${name}</p>
        ${!currentUser.is_admin ? `<button class="auth-pill__item" onclick="navigate('settings')">Become admin</button>` : ''}
        <button class="auth-pill__item" onclick="handleLogout()">Sign out</button>
      </div>
    </details>
  `;
}
