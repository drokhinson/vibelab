'use strict';

// ─── API fetch helpers ────────────────────────────────────────────────────────
const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:8000';

async function fetchCarbs() {
  const res = await fetch(`${API}/api/v1/sauceboss/carbs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Map description → desc for template compatibility
  return data.map(c => ({ ...c, desc: c.description }));
}

async function fetchSaucesForCarb(carbId) {
  const res = await fetch(`${API}/api/v1/sauceboss/carbs/${carbId}/sauces`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const sauces = await res.json();
  // Add ingredientNames Set used by filter logic
  return sauces.map(sauce => ({
    ...sauce,
    ingredientNames: new Set(sauce.ingredients.map(i => i.name)),
  }));
}

async function fetchIngredientsForCarb(carbId) {
  const res = await fetch(`${API}/api/v1/sauceboss/carbs/${carbId}/ingredients`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Unit Conversion (everything → teaspoons for proportional display) ────────
const TO_TSP = { tsp: 1, tsps: 1, tbsp: 3, tbsps: 3, cup: 48, cups: 48, oz: 6, clove: 2, cloves: 2, g: 0.4, piece: 8, pinch: 0.3 };
function toTsp(amount, unit) { return amount * (TO_TSP[unit] || 1); }

// ─── Colour palette ───────────────────────────────────────────────────────────
const PALETTE = [
  '#E85D04','#F48C06','#FAA307','#FFBA08','#E63946','#457B9D','#2A9D8F',
  '#E9C46A','#9B2226','#6D6875','#B5838D','#264653','#BB3E03','#CA6702',
  '#0096C7','#48CAE4','#52B788','#D62828','#F77F00','#FCBF49',
];
// Fixed colours for well-known ingredients
const ING_COLOR = {
  'soy sauce':'#3B1F0A','sesame oil':'#D97706','peanut butter':'#B45309',
  'lime juice':'#84CC16','garlic':'#FDE68A','ginger':'#FCA5A5',
  'honey':'#F59E0B','sriracha':'#EF4444','fish sauce':'#92400E',
  'tamarind paste':'#7C3AED','sugar':'#FEF3C7','brown sugar':'#D4A84B',
  'olive oil':'#65A30D','butter':'#FBBF24','heavy cream':'#FEF9C3',
  'parmesan':'#FCD34D','pine nuts':'#D4A84B','lemon juice':'#FDE047',
  'white wine':'#E9D8A6','chili flakes':'#DC2626','basil':'#22C55E',
  'oregano':'#16A34A','tomato':'#DC2626','ketchup':'#B91C1C',
  'vinegar':'#7DD3FC','rice vinegar':'#BAE6FD','mirin':'#F0ABFC',
  'sake':'#DDD6FE','gochujang':'#DC2626','chipotle':'#A16207',
  'yogurt':'#F5F5F4','sour cream':'#F9FAFB','cream cheese':'#FFFBEB',
  'dijon mustard':'#CA8A04','mustard':'#EAB308','mayo':'#FEF9C3',
  'hot sauce':'#EF4444','worcestershire sauce':'#78350F',
  'cumin':'#D97706','coriander':'#84CC16','turmeric':'#F59E0B',
  'paprika':'#EA580C','garam masala':'#7C3AED','chili powder':'#DC2626',
  'cilantro':'#4ADE80','parsley':'#22C55E','dill':'#86EFAC',
  'spinach':'#15803D','tomato puree':'#B91C1C','coconut milk':'#FFFBEB',
  'onion':'#DDD6FE','shallot':'#C4B5FD','water':'#BFDBFE',
};
function ingColor(name, idx) {
  return ING_COLOR[name.toLowerCase()] || PALETTE[idx % PALETTE.length];
}
// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  screen: 'carb-selector',
  carbs: [],                    // loaded at boot from DB
  selectedCarb: null,
  saucesForCurrentCarb: [],     // loaded in selectCarb() from DB
  allIngredients: [],           // loaded in selectCarb() from DB
  disabledIngredients: new Set(),
  filterOpen: false,
  expandedCuisines: new Set(),
  selectedSauce: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Ingredient frequency helpers ─────────────────────────────────────────────
function getIngredientFrequencies() {
  const freq = {};
  for (const sauce of state.saucesForCurrentCarb) {
    for (const name of sauce.ingredientNames) {
      freq[name] = (freq[name] || 0) + 1;
    }
  }
  return freq;
}

function partitionIngredients() {
  const freq = getIngredientFrequencies();
  const totalSauces = state.saucesForCurrentCarb.length;
  const threshold = Math.max(2, Math.ceil(totalSauces * 0.3));
  const critical = [];
  const other = [];
  for (const name of state.allIngredients) {
    if ((freq[name] || 0) >= threshold) {
      critical.push({ name, count: freq[name] });
    } else {
      other.push({ name, count: freq[name] || 0 });
    }
  }
  critical.sort((a, b) => b.count - a.count);
  return { critical, other };
}

// ─── Pie Chart SVG ────────────────────────────────────────────────────────────
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
  // Single ingredient → draw a full circle (arc math breaks at 360°)
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
    const pct = Math.round((toTsp(item.amount, item.unit) / total) * 100);
    const color = ingColor(item.name, idx);
    return `<div class="legend-item">
      <span class="legend-swatch" style="background:${color}"></span>
      <span class="legend-name">${item.name}</span>
      <span class="legend-amount">${item.amount} ${item.unit}</span>
      <span class="legend-pct">${pct}%</span>
    </div>`;
  }).join('');
}

// ─── Renderers ────────────────────────────────────────────────────────────────
function renderCarbSelector() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo"><span>🍲</span>SauceBoss</div>
      <div class="subtitle">What are you cooking with tonight?</div>
    </div>
    <div class="scroll-body">
      <div class="carb-grid">
        ${state.carbs.map(c => `
          <button class="carb-card" onclick="selectCarb('${c.id}')">
            <span class="carb-emoji">${c.emoji}</span>
            <div class="carb-name">${c.name}</div>
            <div class="carb-desc">${c.desc}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSauceSelector() {
  const carb = state.selectedCarb;
  const sauces = state.saucesForCurrentCarb;
  const ingredients = state.allIngredients;
  const cuisines = [...new Set(sauces.map(s => s.cuisine))];
  const missingCount = state.disabledIngredients.size;

  const { critical, other } = partitionIngredients();

  const chipHTML = (items) => items.map(({ name }) => {
    const has = !state.disabledIngredients.has(name);
    return `<button class="chip ${has ? 'has' : 'missing'}" data-ingredient="${name.replace(/"/g, '&quot;')}">
      ${has ? '✓' : '✗'} ${name}
    </button>`;
  }).join('');

  const filterBody = `
    <div class="filter-body ${state.filterOpen ? 'open' : ''}">
      <p class="filter-hint">Uncheck ingredients you don't have — sauces will update.</p>
      ${critical.length > 0 ? `
        <div class="ingredient-section">
          <p class="ingredient-section-label">
            <span class="section-label-icon">★</span>
            Staples <span class="section-label-detail">— unlock the most sauces</span>
          </p>
          <div class="ingredient-chips">${chipHTML(critical)}</div>
        </div>
      ` : ''}
      ${other.length > 0 ? `
        <div class="ingredient-section">
          <p class="ingredient-section-label">Other ingredients</p>
          <div class="ingredient-chips">${chipHTML(other)}</div>
        </div>
      ` : ''}
    </div>
  `;

  const accordionHTML = cuisines.map(cuisine => {
    const cuisineSauces = sauces.filter(s => s.cuisine === cuisine);
    const emoji = cuisineSauces[0]?.cuisineEmoji || '🍽️';
    const isOpen = state.expandedCuisines.has(cuisine);
    const availCount = cuisineSauces.filter(isSauceAvailable).length;

    const saucesHTML = cuisineSauces.map(sauce => {
      const available = isSauceAvailable(sauce);
      const missing = missingSauceIngredients(sauce);
      return `<div class="sauce-item ${available ? '' : 'unavailable'}" onclick="selectSauce('${sauce.id}')">
        <span class="sauce-dot" style="background:${sauce.color}"></span>
        <div class="sauce-info">
          <div class="sauce-item-name">${sauce.name}</div>
          <div class="sauce-item-tags">${sauce.compatibleCarbs.join(' · ')}${missing.length ? ' · missing: '+missing.join(', ') : ''}</div>
        </div>
        ${!available ? `<span class="sauce-missing-badge">-${missing.length}</span>` : ''}
        <span class="sauce-arrow">›</span>
      </div>`;
    }).join('');

    return `<div class="cuisine-group ${isOpen ? 'open' : ''}" id="cg-${cuisine}">
      <button class="cuisine-header" onclick="toggleCuisine('${cuisine}')">
        <span class="cuisine-flag">${emoji}</span>
        <span class="cuisine-name">${cuisine}</span>
        <span class="cuisine-count">${availCount}/${cuisineSauces.length}</span>
        <span class="cuisine-chevron">▾</span>
      </button>
      <div class="sauce-list">${saucesHTML}</div>
    </div>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>${carb.emoji}</span>${carb.name} Sauces</div>
      <div class="subtitle">${sauces.length} sauces · select your cuisine</div>
    </div>
    <div class="scroll-body">
      <p class="section-label">Ingredient filter</p>
      <div class="filter-panel">
        <button class="filter-header" onclick="toggleFilter()">
          <span class="filter-header-text">🛒 My Pantry${missingCount > 0 ? `<span class="filter-count">−${missingCount} hidden</span>` : ''}</span>
          <span class="filter-chevron ${state.filterOpen ? 'open' : ''}">▾</span>
        </button>
        ${filterBody}
      </div>
      <p class="section-label">Pick a sauce</p>
      ${accordionHTML}
    </div>
  `;
}

function renderRecipe() {
  const sauce = state.selectedSauce;
  const carb = state.selectedCarb;
  const stepsHTML = sauce.steps.map((step, i) => {
    const items = step.ingredients;
    return `<div class="step-card">
      <div class="step-number">Step ${i + 1}</div>
      <div class="step-title">${step.title}</div>
      <div class="pie-container">
        ${buildPieChart(items, 170)}
        <div class="legend">${buildLegend(items)}</div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="recipe-header">
      <button class="back-btn" onclick="navigate('sauce-selector')">‹ Back</button>
      <div class="recipe-cuisine-badge">${sauce.cuisineEmoji} ${sauce.cuisine}</div>
      <div class="recipe-title">${sauce.name}</div>
      <div class="recipe-subtitle">Pair with: ${sauce.compatibleCarbs.join(', ')} &nbsp;·&nbsp; ${sauce.steps.length} step${sauce.steps.length > 1 ? 's' : ''}</div>
    </div>
    <div class="scroll-body" style="padding:0">
      <div class="steps-container">
        ${stepsHTML}
      </div>
      <div class="tip-card">
        <strong>💡 How to read the chart</strong>
        Each slice shows the relative proportion of that ingredient. Bigger slice = more of it. Perfect for scaling up or down by eye!
      </div>
    </div>
  `;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'carb-selector':   app.innerHTML = renderCarbSelector(); break;
    case 'sauce-selector':  app.innerHTML = renderSauceSelector(); break;
    case 'recipe':          app.innerHTML = renderRecipe(); break;
  }
}
function navigate(screen) { state.screen = screen; render(); }

// ─── Actions ──────────────────────────────────────────────────────────────────
async function selectCarb(id) {
  state.selectedCarb = state.carbs.find(c => c.id === id);
  // Show loading immediately while fetching sauces + ingredients
  document.getElementById('app').innerHTML = `
    <div class="loading-screen">
      <div class="spinner"></div>
      <p class="loading-text">Loading sauces…</p>
    </div>`;
  try {
    const [sauces, ingredients] = await Promise.all([
      fetchSaucesForCarb(id),
      fetchIngredientsForCarb(id),
    ]);
    state.saucesForCurrentCarb = sauces;
    state.allIngredients       = ingredients;
    state.disabledIngredients  = new Set();
    state.filterOpen           = false;
    state.expandedCuisines     = new Set([sauces[0]?.cuisine].filter(Boolean));
    state.screen = 'sauce-selector';
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load sauces: ${err.message}<br>
        <button onclick="navigate('carb-selector')" style="margin-top:1rem">‹ Back</button>
      </div>`;
  }
}
function selectSauce(id) {
  state.selectedSauce = state.saucesForCurrentCarb.find(s => s.id === id);
  navigate('recipe');
}
function toggleFilter() {
  state.filterOpen = !state.filterOpen;
  render();
}
function toggleIngredient(name) {
  if (state.disabledIngredients.has(name)) {
    state.disabledIngredients.delete(name);
  } else {
    state.disabledIngredients.add(name);
  }
  render();
}
function toggleCuisine(name) {
  if (state.expandedCuisines.has(name)) {
    state.expandedCuisines.delete(name);
  } else {
    state.expandedCuisines.add(name);
  }
  render();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    state.carbs = await fetchCarbs();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load: ${err.message}
      </div>`;
    return;
  }
  render();

  // Delegated handler for ingredient chips (avoids fragile inline onclick escaping)
  document.getElementById('app').addEventListener('click', e => {
    const chip = e.target.closest('.chip[data-ingredient]');
    if (chip) toggleIngredient(chip.dataset.ingredient);
  });
});
