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
const PREFIX = '/api/v1/sauceboss';

fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: window.APP_CONFIG?.project || 'sauceboss', event: 'app_open' })
}).catch(() => {});

// Auth-aware fetch wrapper. Adds Authorization header when a Supabase session
// is active. Body is JSON-stringified if it's a plain object. Throws an Error
// with the backend's `detail` field on non-2xx responses.
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (session?.access_token) headers['Authorization'] = 'Bearer ' + session.access_token;
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const url = `${API}${PREFIX}${path}`;
  const res = await fetch(url, { ...opts, headers, body });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.detail && j.detail.message) || j.detail || '';
    } catch { /* ignore */ }
    const msg = detail ? `${res.status} ${detail}` : `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function _withIngredientNames(sauce) {
  return { ...sauce, ingredientNames: new Set(sauce.ingredients.map(i => i.name)) };
}

async function _loggedJson(url) {
  console.log('[sauceboss] fetch →', url);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error('[sauceboss] network error on', url, e);
    throw new Error(`Network error reaching ${url}: ${e.message}`);
  }
  console.log('[sauceboss] fetch ←', url, res.status, res.statusText);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''} (${url})`);
  }
  return res.json();
}

async function fetchInitialLoad() {
  const data = await _loggedJson(`${API}/api/v1/sauceboss/initial-load`);
  return {
    carbs: data.carbs || [],
    proteins: data.proteins || [],
    saladBases: data.saladBases || [],
  };
}

async function fetchItemLoad(itemId) {
  const data = await _loggedJson(`${API}/api/v1/sauceboss/items/${encodeURIComponent(itemId)}/load`);
  return {
    item: data.item || null,
    variants: data.variants || [],
    sauces: (data.sauces || []).map(_withIngredientNames),
    ingredients: data.ingredients || [],
  };
}

async function fetchIngredientCategories() {
  const res = await fetch(`${API}/api/v1/sauceboss/ingredient-categories`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function availableCuisines() {
  const seen = new Map();
  for (const c of CUISINES) seen.set(c.name, c.emoji);
  for (const s of (state.adminSauces || [])) {
    if (s.cuisine && !seen.has(s.cuisine)) seen.set(s.cuisine, s.cuisineEmoji || '🍽');
  }
  return [...seen].map(([name, emoji]) => ({ name, emoji }));
}

async function fetchSubstitutions() {
  const res = await fetch(`${API}/api/v1/sauceboss/substitutions`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchUnits() {
  const data = await _loggedJson(`${API}/api/v1/sauceboss/units`);
  return data.units || [];
}

async function fetchFoods(query, limit = 20) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', String(limit));
  const data = await _loggedJson(`${API}/api/v1/sauceboss/foods?${params.toString()}`);
  return data.foods || [];
}

async function importRecipeFromUrl(url) {
  const res = await fetch(`${API}/api/v1/sauceboss/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = (body.detail && body.detail.message) || body.detail || '';
    } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function createSauce(data) {
  return apiFetch('/sauces', { method: 'POST', body: data });
}

async function updateSauce(id, data) {
  return apiFetch(`/sauces/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });
}

async function fetchAllSauces() {
  const sauces = await apiFetch('/sauces');
  return sauces.map(sauce => ({
    ...sauce,
    ingredientNames: new Set(sauce.ingredients.map(i => i.name)),
  }));
}

async function fetchAdminSauces() {
  return apiFetch('/admin/sauces');
}

async function adminCreateItem(data) {
  return apiFetch('/admin/items', { method: 'POST', body: data });
}

async function fetchItems() {
  return apiFetch('/items');
}

async function adminUpdateItem(id, data) {
  return apiFetch(`/admin/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });
}

async function adminDeleteItem(id) {
  return apiFetch(`/admin/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function deleteAdminSauce(id) {
  return apiFetch(`/admin/sauces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Owner-or-admin delete. Backend validates `created_by == current user OR is_admin`.
// Used from the sauce manager so a logged-in user can remove a recipe they
// authored without needing the admin claim.
async function deleteSauceOwned(id) {
  return apiFetch(`/sauces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Ingredient (food) admin ─────────────────────────────────────────────────
async function fetchFoodsWithUsage() {
  const data = await apiFetch('/foods-with-usage');
  return data.foods || [];
}

async function adminCreateFood(payload) {
  return apiFetch('/admin/foods', { method: 'POST', body: payload });
}

async function adminUpdateFood(id, payload) {
  return apiFetch(`/admin/foods/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
}

async function adminDeleteFood(id) {
  return apiFetch(`/admin/foods/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function adminMergeFoods(keepId, mergeIds) {
  return apiFetch('/admin/foods/merge', { method: 'POST', body: { keepId, mergeIds } });
}

async function adminAssignSauceVariants(parentId, sauceIds) {
  return apiFetch(`/admin/sauces/${encodeURIComponent(parentId)}/variants`, {
    method: 'POST',
    body: { sauceIds },
  });
}

// ─── Favorites + profile (auth required) ─────────────────────────────────────
async function fetchProfile() {
  return apiFetch('/profile');
}

async function createProfile(displayName) {
  return apiFetch('/profile', { method: 'POST', body: { display_name: displayName } });
}

async function becomeAdmin(adminKey) {
  return apiFetch('/profile/become-admin', { method: 'POST', body: { admin_key: adminKey } });
}

async function fetchFavorites() {
  const data = await apiFetch('/favorites');
  const map = new Map();
  for (const entry of (data.favorites || [])) {
    map.set(entry.sauceId, entry.createdAt || null);
  }
  return map;
}

async function addFavorite(sauceId) {
  return apiFetch(`/favorites/${encodeURIComponent(sauceId)}`, { method: 'PUT' });
}

async function removeFavorite(sauceId) {
  return apiFetch(`/favorites/${encodeURIComponent(sauceId)}`, { method: 'DELETE' });
}

// Optimistic favorite toggle. Updates state immediately, syncs in the background,
// reverts on failure and re-renders.
async function toggleFavorite(sauceId) {
  if (!currentUser) { openAuthModal(); return; }
  const wasFavorited = state.favorites.has(sauceId);
  const previousTimestamp = state.favorites.get(sauceId);
  if (wasFavorited) state.favorites.delete(sauceId);
  else state.favorites.set(sauceId, new Date().toISOString());
  render();
  try {
    if (wasFavorited) await removeFavorite(sauceId);
    else await addFavorite(sauceId);
  } catch (e) {
    console.error('[sauceboss] favorite toggle failed:', e);
    if (wasFavorited) state.favorites.set(sauceId, previousTimestamp || null);
    else state.favorites.delete(sauceId);
    render();
  }
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

// ─── Navigation ───────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'meal-builder':           app.innerHTML = renderMealBuilder(); break;
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
  _initIcons();
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
