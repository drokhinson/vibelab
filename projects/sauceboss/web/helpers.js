'use strict';

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
  const res = await fetch(`${API}/api/v1/sauceboss/sauces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchAllSauces() {
  const res = await fetch(`${API}/api/v1/sauceboss/sauces`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const sauces = await res.json();
  return sauces.map(sauce => ({
    ...sauce,
    ingredientNames: new Set(sauce.ingredients.map(i => i.name)),
  }));
}

async function fetchAdminSauces(key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/sauces`, {
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function adminCreateItem(data, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchItems() {
  const res = await fetch(`${API}/api/v1/sauceboss/items`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function adminUpdateItem(id, data, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function adminDeleteItem(id, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function deleteAdminSauce(id, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/sauces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Ingredient (food) admin ─────────────────────────────────────────────────
async function fetchFoodsWithUsage() {
  const data = await _loggedJson(`${API}/api/v1/sauceboss/foods-with-usage`);
  return data.foods || [];
}

async function adminCreateFood(payload, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/foods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function adminUpdateFood(id, payload, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/foods/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function adminDeleteFood(id, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/foods/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function adminMergeFoods(keepId, mergeIds, key) {
  const res = await fetch(`${API}/api/v1/sauceboss/admin/foods/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ keepId, mergeIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Unit conversion ──────────────────────────────────────────────────────────
function toTsp(amount, unit) { return amount * (TO_TSP[unit] || 1); }

// `item` is optional. When passed and metric mode is on, server-supplied
// canonicalMl / canonicalG (set by the Mealie-inspired ingredient migration)
// take precedence over the in-JS lookup tables — this keeps display numbers
// consistent with what the backend stores.
function convertUnit(amount, unit, system, item) {
  if (system === 'imperial') return { amount, unit };
  if (item) {
    if (item.canonicalMl != null) return { amount: item.canonicalMl, unit: 'ml' };
    if (item.canonicalG  != null) return { amount: item.canonicalG,  unit: 'g'  };
  }
  const lower = (unit || '').toLowerCase();
  if (COUNT_UNITS.has(lower)) return { amount, unit };
  if (VOLUME_TO_ML[lower]) return { amount: amount * VOLUME_TO_ML[lower], unit: 'ml' };
  if (WEIGHT_TO_G[lower])  return { amount: amount * WEIGHT_TO_G[lower], unit: 'g' };
  return { amount, unit };
}

function formatAmount(num) {
  if (num >= 10) return Math.round(num).toString();
  const rounded = Math.round(num * 10) / 10;
  return rounded === Math.floor(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function scaleAmount(amount, servings) {
  return amount * (servings / 2); // base recipes are for 2 people
}

function ingColor(name, idx) {
  if (name.toLowerCase().startsWith('step ') && name.toLowerCase().includes('combined')) return STEP_OUTPUT_COLOR;
  return ING_COLOR[name.toLowerCase()] || PALETTE[idx % PALETTE.length];
}

// ─── Sauce filter helpers ─────────────────────────────────────────────────────
function isSauceAvailable(sauce) {
  for (const name of sauce.ingredientNames) {
    if (state.disabledIngredients.has(name)) return false;
  }
  return true;
}

function missingSauceIngredients(sauce) {
  const missing = [];
  for (const name of sauce.ingredientNames) {
    if (state.disabledIngredients.has(name)) missing.push(name);
  }
  return missing;
}

function getSubstitutionText(ingredientName) {
  const subs = state.substitutions[ingredientName];
  if (!subs || subs.length === 0) return '';
  return subs[0].substituteName;
}

// Returns the sauce list + ingredient list for the currently selected item.
function getCurrentSauceContext() {
  return { sauces: state.saucesForCurrentItem, allIngredients: state.allIngredients };
}

function getIngredientFrequencies() {
  const { sauces } = getCurrentSauceContext();
  const freq = {};
  for (const sauce of sauces) {
    for (const name of sauce.ingredientNames) {
      freq[name] = (freq[name] || 0) + 1;
    }
  }
  return freq;
}

function groupIngredientsByCategory() {
  const { sauces, allIngredients } = getCurrentSauceContext();
  const freq = getIngredientFrequencies();
  const totalSauces = sauces.length;
  const threshold = Math.max(2, Math.ceil(totalSauces * 0.3));

  const keySet = new Set();
  const keyItems = [];
  for (const name of allIngredients) {
    if ((freq[name] || 0) >= threshold) {
      keySet.add(name);
      keyItems.push({ name, count: freq[name] });
    }
  }
  keyItems.sort((a, b) => b.count - a.count);

  const groups = {};
  for (const name of allIngredients) {
    if (keySet.has(name)) continue;
    const category = state.ingredientCategories[name] || 'Pantry Staples';
    if (!groups[category]) groups[category] = [];
    groups[category].push({ name, count: freq[name] || 0 });
  }

  const result = [];
  if (keyItems.length > 0) result.push({ category: 'Key Ingredients', items: keyItems, isKey: true });
  for (const c of CATEGORY_ORDER) {
    if (groups[c]) result.push({ category: c, items: groups[c] });
  }
  return result;
}

// ─── Fuzzy matching helpers ───────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function fuzzyMatchIngredients(query) {
  query = query.toLowerCase().trim();
  if (query.length < 2) return [];
  const known = Object.keys(state.ingredientCategories);
  return known
    .map(name => {
      const lower = name.toLowerCase();
      if (lower === query) return { name, score: 10 };
      if (lower.startsWith(query)) return { name, score: 5 };
      if (lower.includes(query)) return { name, score: 3 };
      const dist = levenshtein(query, lower);
      if (dist <= 2) return { name, score: 2 - dist * 0.5 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(m => m.name);
}

function isKnownIngredient(name) {
  return name.trim().toLowerCase() in state.ingredientCategories
    || Object.keys(state.ingredientCategories).some(k => k.toLowerCase() === name.trim().toLowerCase());
}

async function classifyIngredient(name, category) {
  state.ingredientCategories[name.trim().toLowerCase()] = category;
  fetch(`${API}/api/v1/sauceboss/ingredient-categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientName: name.trim(), category }),
  }).catch(() => {});
}

// ─── Pie chart SVG ────────────────────────────────────────────────────────────
function polarToCartesian(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, startDeg, endDeg) {
  if (endDeg - startDeg >= 360) endDeg = startDeg + 359.99;
  const s = polarToCartesian(cx, cy, r, startDeg);
  const e = polarToCartesian(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${cx} ${cy} L${s.x.toFixed(2)} ${s.y.toFixed(2)} A${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}Z`;
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
