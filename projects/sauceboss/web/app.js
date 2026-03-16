'use strict';

// ─── Flag emoji fallback ─────────────────────────────────────────────────────
// Windows doesn't render flag emojis — detect and replace with CDN flag images.
const FLAG_SUPPORTED = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '32px Arial';
    // Measure a flag emoji vs a non-flag emoji. If they render the same width,
    // the flag isn't supported (it's rendering as two letter characters).
    const flagW = ctx.measureText('\u{1F1EB}\u{1F1F7}').width; // 🇫🇷
    const charW = ctx.measureText('FR').width;
    return flagW !== charW;
  } catch { return true; }
})();

// Map regional indicator pairs → ISO country codes for flagcdn.com
function flagEmojiToCode(emoji) {
  const codePoints = [...emoji].map(c => c.codePointAt(0));
  // Regional indicator symbols are U+1F1E6 (A) through U+1F1FF (Z)
  if (codePoints.length === 2 && codePoints.every(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF)) {
    return String.fromCharCode(codePoints[0] - 0x1F1E6 + 65, codePoints[1] - 0x1F1E6 + 65).toLowerCase();
  }
  return null;
}

function renderEmoji(emoji) {
  if (FLAG_SUPPORTED) return emoji;
  const code = flagEmojiToCode(emoji);
  if (code) {
    return `<img src="https://flagcdn.com/w40/${code}.png" alt="${emoji}" class="flag-img">`;
  }
  return emoji; // non-flag emoji, render as-is
}

// ─── API fetch helpers ────────────────────────────────────────────────────────
const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || 'http://localhost:8000';

// Analytics — fire-and-forget app open tracking
fetch(`${API}/api/v1/analytics/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: window.APP_CONFIG?.project || 'sauceboss', event: 'app_open' })
}).catch(() => {});

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

async function fetchIngredientCategories() {
  const res = await fetch(`${API}/api/v1/sauceboss/ingredient-categories`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchSubstitutions() {
  const res = await fetch(`${API}/api/v1/sauceboss/substitutions`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPreparationsForCarb(carbId) {
  const res = await fetch(`${API}/api/v1/sauceboss/carbs/${carbId}/preparations`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

// ─── Builder constants ───────────────────────────────────────────────────────
const CUISINES = [
  { name: 'Italian', emoji: '🇮🇹' },
  { name: 'Asian', emoji: '🌏' },
  { name: 'Mexican', emoji: '🇲🇽' },
  { name: 'Mediterranean', emoji: '🫒' },
  { name: 'BBQ', emoji: '🔥' },
  { name: 'French', emoji: '🇫🇷' },
  { name: 'Indian', emoji: '🇮🇳' },
];
const UNITS = ['tsp', 'tbsp', 'cup', 'oz', 'g', 'clove', 'cloves', 'piece', 'pinch'];
const COLOR_SWATCHES = ['#E85D04','#DC2626','#22C55E','#3B1F0A','#FBBF24','#457B9D','#7C3AED','#EA580C','#15803D','#B91C1C'];

function defaultBuilder() {
  return {
    name: '', cuisine: '', cuisineEmoji: '', color: '#E85D04', description: '',
    steps: [{ title: '', inputFromStep: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] }],
    carbIds: [], saving: false, error: null,
    // Autocomplete state
    acStep: null, acIng: null, acResults: [], acSelected: -1,
    // Category classification queue: [{step, ing, name}]
    pendingCategories: [],
  };
}

// ─── Fuzzy matching helpers ─────────────────────────────────────────────────
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
      if (lower === query) return { name, score: 10 };       // exact
      if (lower.startsWith(query)) return { name, score: 5 }; // prefix
      if (lower.includes(query)) return { name, score: 3 };   // substring
      const dist = levenshtein(query, lower);
      if (dist <= 2) return { name, score: 2 - dist * 0.5 };  // typo
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
  // Save locally
  state.ingredientCategories[name.trim().toLowerCase()] = category;
  // Persist to backend (fire-and-forget)
  fetch(`${API}/api/v1/sauceboss/ingredient-categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientName: name.trim(), category }),
  }).catch(() => {});
}

// ─── Unit Conversion (everything → teaspoons for proportional display) ────────
const TO_TSP = { tsp: 1, tsps: 1, tbsp: 3, tbsps: 3, cup: 48, cups: 48, oz: 6, clove: 2, cloves: 2, g: 0.4, piece: 8, pinch: 0.3 };
function toTsp(amount, unit) { return amount * (TO_TSP[unit] || 1); }

// ─── Metric / Imperial conversion ────────────────────────────────────────────
const VOLUME_TO_ML = { tsp: 5, tbsp: 15, cup: 240, oz: 30 };
const WEIGHT_TO_G  = { oz: 28 };
const COUNT_UNITS  = new Set(['clove', 'cloves', 'piece', 'pieces', 'pinch']);

function convertUnit(amount, unit, system) {
  if (system === 'imperial') return { amount, unit };
  const lower = unit.toLowerCase();
  if (COUNT_UNITS.has(lower)) return { amount, unit };
  if (VOLUME_TO_ML[lower]) return { amount: amount * VOLUME_TO_ML[lower], unit: 'ml' };
  if (WEIGHT_TO_G[lower])  return { amount: amount * WEIGHT_TO_G[lower], unit: 'g' };
  // Already metric or unknown — pass through
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
const STEP_OUTPUT_COLOR = '#94A3B8'; // slate for "Step N output" slices
function ingColor(name, idx) {
  if (name.toLowerCase().startsWith('step ') && name.toLowerCase().includes('output')) return STEP_OUTPUT_COLOR;
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
  // New state
  servings: 2,                  // number of people (default 2)
  unitSystem: 'imperial',       // 'imperial' | 'metric'
  ingredientCategories: {},     // name → category lookup
  substitutions: {},            // name → [{substituteName, notes}] lookup
  preparations: [],             // loaded per carb in selectCarb()
  selectedPrep: null,           // currently selected preparation object
  builder: null,                // recipe builder state (set via defaultBuilder())
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

function getSubstitutionText(ingredientName) {
  const subs = state.substitutions[ingredientName];
  if (!subs || subs.length === 0) return '';
  return subs[0].substituteName;
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

const CATEGORY_ORDER = ['Produce', 'Dairy', 'Oils & Fats', 'Sauces & Condiments', 'Spices', 'Sweeteners', 'Nuts & Seeds', 'Pantry Staples'];

function groupIngredientsByCategory() {
  const freq = getIngredientFrequencies();
  const totalSauces = state.saucesForCurrentCarb.length;
  const threshold = Math.max(2, Math.ceil(totalSauces * 0.3));

  // Key ingredients appear in ≥30% of sauces for this carb
  const keySet = new Set();
  const keyItems = [];
  for (const name of state.allIngredients) {
    if ((freq[name] || 0) >= threshold) {
      keySet.add(name);
      keyItems.push({ name, count: freq[name] });
    }
  }
  keyItems.sort((a, b) => b.count - a.count);

  // Remaining ingredients grouped by category
  const groups = {};
  for (const name of state.allIngredients) {
    if (keySet.has(name)) continue;
    const category = state.ingredientCategories[name] || 'Pantry Staples';
    if (!groups[category]) groups[category] = [];
    groups[category].push({ name, count: freq[name] || 0 });
  }

  const result = [];
  if (keyItems.length > 0) {
    result.push({ category: 'Key Ingredients', items: keyItems, isKey: true });
  }
  for (const c of CATEGORY_ORDER) {
    if (groups[c]) result.push({ category: c, items: groups[c] });
  }
  return result;
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
    const converted = convertUnit(item.amount, item.unit, state.unitSystem);
    const isDisabled = state.disabledIngredients.has(item.name);
    const sub = isDisabled ? getSubstitutionText(item.name) : '';
    return `<div class="legend-item${isDisabled ? ' legend-disabled' : ''}">
      <span class="legend-swatch" style="background:${color}"></span>
      <div class="legend-name-wrap">
        <span class="legend-name">${item.name}</span>
        ${sub ? `<span class="sub-hint">try ${sub}</span>` : ''}
      </div>
      <span class="legend-amount">${formatAmount(converted.amount)} ${converted.unit}</span>
      <span class="legend-pct">${pct}%</span>
    </div>`;
  }).join('');
}

// ─── Scale + convert items for display ───────────────────────────────────────
function prepareItems(items) {
  return items.map(item => {
    const scaled = scaleAmount(item.amount, state.servings);
    const converted = convertUnit(scaled, item.unit, state.unitSystem);
    return { name: item.name, amount: converted.amount, unit: converted.unit };
  });
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
      <button class="create-sauce-btn" onclick="openBuilder()">+ Create a Sauce</button>
    </div>
  `;
}

function renderPrepSelector() {
  const carb = state.selectedCarb;
  const preps = state.preparations;
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>${carb.emoji}</span>${carb.name}</div>
      <div class="subtitle">How are you preparing it?</div>
    </div>
    <div class="scroll-body">
      <div class="carb-grid">
        ${preps.map(p => `
          <button class="carb-card" onclick="selectPrep('${p.id}')">
            <span class="carb-emoji">${p.emoji || carb.emoji}</span>
            <div class="carb-name">${p.name}</div>
            <div class="carb-desc">${p.cookTime || ''}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSauceSelector() {
  const carb = state.selectedCarb;
  const sauces = state.saucesForCurrentCarb;
  const cuisines = [...new Set(sauces.map(s => s.cuisine))];
  const missingCount = state.disabledIngredients.size;

  const categoryGroups = groupIngredientsByCategory();

  const chipHTML = (items) => items.map(({ name }) => {
    const has = !state.disabledIngredients.has(name);
    return `<button class="chip ${has ? 'has' : 'missing'}" data-ingredient="${name.replace(/"/g, '&quot;')}">
      ${has ? '✓' : '✗'} ${name}
    </button>`;
  }).join('');

  const filterBody = `
    <div class="filter-body ${state.filterOpen ? 'open' : ''}">
      <p class="filter-hint">Uncheck ingredients you don't have — sauces will update.</p>
      ${categoryGroups.map(({ category, items, isKey }) => `
        <div class="ingredient-section${isKey ? ' key-section' : ''}">
          <p class="ingredient-section-label">
            ${isKey ? '<span class="section-label-icon">★</span>' : ''}${category}
            ${isKey ? '<span class="section-label-detail">— unlock the most sauces</span>' : ''}
          </p>
          <div class="ingredient-chips">${chipHTML(items)}</div>
        </div>
      `).join('')}
    </div>
  `;

  const accordionHTML = cuisines.map(cuisine => {
    const cuisineSauces = sauces.filter(s => s.cuisine === cuisine);
    const emoji = renderEmoji(cuisineSauces[0]?.cuisineEmoji || '🍽️');
    const isOpen = state.expandedCuisines.has(cuisine);
    const availCount = cuisineSauces.filter(isSauceAvailable).length;

    const saucesHTML = cuisineSauces.map(sauce => {
      const available = isSauceAvailable(sauce);
      const missing = missingSauceIngredients(sauce);
      const missingText = missing.map(m => {
        const sub = getSubstitutionText(m);
        return sub ? `${m} (try ${sub})` : m;
      }).join(', ');
      return `<div class="sauce-item ${available ? '' : 'unavailable'}" onclick="selectSauce('${sauce.id}')">
        <span class="sauce-dot" style="background:${sauce.color}"></span>
        <div class="sauce-info">
          <div class="sauce-item-name">${sauce.name}</div>
          <div class="sauce-item-tags">${sauce.compatibleCarbs.join(' · ')}${missing.length ? ' · missing: '+missingText : ''}</div>
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
      <button class="back-btn" onclick="navigate('${state.preparations.length > 0 ? 'prep-selector' : 'carb-selector'}')">‹ Back</button>
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

// ─── Builder Screens ─────────────────────────────────────────────────────────
function renderBuilder() {
  const b = state.builder;
  const esc = s => (s || '').replace(/"/g, '&quot;');

  const cuisineChips = CUISINES.map(c =>
    `<button class="cuisine-chip ${b.cuisine === c.name ? 'selected' : ''}" onclick="builderSetCuisine('${c.name}','${c.emoji}')">${renderEmoji(c.emoji)} ${c.name}</button>`
  ).join('');

  const colorDots = COLOR_SWATCHES.map(hex =>
    `<button class="color-swatch ${b.color === hex ? 'selected' : ''}" style="background:${hex}" onclick="builderSetColor('${hex}')"></button>`
  ).join('');

  const stepsHTML = b.steps.map((step, si) => {
    // Step reference dropdown (steps after the first can reference a previous step)
    const stepRefHTML = si > 0 ? `
      <div class="step-ref-row">
        <label class="step-ref-label">Uses output from:</label>
        <select class="step-ref-select" data-builder-field="input-from-step" data-step="${si}">
          <option value="" ${!step.inputFromStep ? 'selected' : ''}>None</option>
          ${b.steps.slice(0, si).map((_, ri) =>
            `<option value="${ri + 1}" ${step.inputFromStep === ri + 1 ? 'selected' : ''}>Step ${ri + 1}${b.steps[ri].title ? ' — ' + b.steps[ri].title.slice(0, 25) : ''}</option>`
          ).join('')}
        </select>
      </div>` : '';

    const ingsHTML = step.ingredients.map((ing, ii) => {
      // Show autocomplete dropdown for the active ingredient input
      const isAcActive = b.acStep === si && b.acIng === ii && b.acResults.length > 0;
      const acDropdown = isAcActive ? `
        <div class="ac-dropdown">
          ${b.acResults.map((name, idx) =>
            `<div class="ac-item ${idx === b.acSelected ? 'ac-selected' : ''}" data-ac-pick="${name.replace(/"/g, '&quot;')}" data-step="${si}" data-ing="${ii}">${name}</div>`
          ).join('')}
        </div>` : '';

      // Category classification prompt (shown when ingredient is new and needs classification)
      const needsCategory = ing.name.trim().length >= 2 && !isKnownIngredient(ing.name) && ing._showCategory;
      const categoryChips = needsCategory ? `
        <div class="category-classify">
          <span class="category-classify-label">Classify "${ing.name.trim()}":</span>
          <div class="category-chips">
            ${CATEGORY_ORDER.map(cat =>
              `<button class="category-chip" data-classify-cat="${cat}" data-step="${si}" data-ing="${ii}">${cat}</button>`
            ).join('')}
          </div>
        </div>` : '';

      return `<div class="ingredient-row-wrap">
        <div class="ingredient-row">
          <div class="ing-name-wrap">
            <input class="builder-input ing-name" placeholder="Ingredient" value="${esc(ing.name)}" data-builder-field="ing-name" data-step="${si}" data-ing="${ii}" autocomplete="off">
            ${acDropdown}
          </div>
          <input class="builder-input ing-amount" type="number" step="0.1" min="0" placeholder="Qty" value="${ing.amount}" data-builder-field="ing-amount" data-step="${si}" data-ing="${ii}">
          <select class="ing-unit" data-builder-field="ing-unit" data-step="${si}" data-ing="${ii}">
            ${UNITS.map(u => `<option ${ing.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
          ${step.ingredients.length > 1 ? `<button class="remove-ing-btn" onclick="builderRemoveIngredient(${si},${ii})">✕</button>` : ''}
        </div>
        ${categoryChips}
      </div>`;
    }).join('');

    return `<div class="builder-step-card">
      ${b.steps.length > 1 ? `<button class="remove-step-btn" onclick="builderRemoveStep(${si})">✕</button>` : ''}
      <div class="step-number">Step ${si + 1}</div>
      ${stepRefHTML}
      <input class="builder-input" placeholder="Step title (e.g., Sauté the base)" value="${esc(step.title)}" data-builder-field="step-title" data-step="${si}">
      <div class="builder-ings-list">${ingsHTML}</div>
      <button class="add-ing-btn" onclick="builderAddIngredient(${si})">+ Ingredient</button>
    </div>`;
  }).join('');

  const canContinue = b.name.trim() && b.cuisine && b.steps.some(s => s.title.trim() && s.ingredients.some(i => i.name.trim() && i.amount));

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('carb-selector')">‹ Back</button>
      <div class="logo"><span>🍲</span>Create a Sauce</div>
    </div>
    <div class="scroll-body">
      <div class="builder-sticky-header">
        <input class="builder-input builder-name-input" placeholder="Sauce name" value="${esc(b.name)}" data-builder-field="name">
        <p class="builder-label">Cuisine</p>
        <div class="cuisine-chips">${cuisineChips}</div>
        <p class="builder-label">Color</p>
        <div class="color-swatches">${colorDots}</div>
      </div>
      <p class="builder-label" style="margin-top:16px">Steps</p>
      ${stepsHTML}
      <button class="add-step-btn" onclick="builderAddStep()">+ Add Step</button>
      <button class="builder-primary-btn" onclick="navigate('builder-carbs')" ${canContinue ? '' : 'disabled'}>Continue — Pair with Carbs</button>
    </div>
  `;
}

function renderBuilderCarbs() {
  const b = state.builder;
  const carbsHTML = state.carbs.map(c => {
    const selected = b.carbIds.includes(c.id);
    return `<button class="carb-card carb-card-check ${selected ? 'selected' : ''}" onclick="builderToggleCarb('${c.id}')">
      ${selected ? '<span class="check-mark">✓</span>' : ''}
      <span class="carb-emoji">${c.emoji}</span>
      <div class="carb-name">${c.name}</div>
    </button>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('builder')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name || 'New Sauce'}</div>
      <div class="subtitle">${b.cuisine ? renderEmoji(b.cuisineEmoji) + ' ' + b.cuisine : 'Select carbs'}</div>
    </div>
    <div class="scroll-body">
      <p class="section-label">Which carbs go with this sauce?</p>
      <div class="carb-grid">${carbsHTML}</div>
      <button class="builder-primary-btn" onclick="navigate('builder-review')" ${b.carbIds.length > 0 ? '' : 'disabled'}>Review Sauce</button>
    </div>
  `;
}

function renderBuilderReview() {
  const b = state.builder;
  const pairedCarbs = state.carbs.filter(c => b.carbIds.includes(c.id));
  const totalIngs = b.steps.reduce((sum, s) => sum + s.ingredients.filter(i => i.name.trim()).length, 0);

  const stepsPreview = b.steps.map((step, si) => `
    <div class="review-step-card">
      <div class="step-number">Step ${si + 1}</div>
      <div class="step-title">${step.title || '(untitled)'}</div>
      ${step.inputFromStep ? `<div class="step-ref-badge">⤶ Uses Step ${step.inputFromStep} output</div>` : ''}
      <div class="review-ing-list">
        ${step.ingredients.filter(i => i.name.trim()).map(i =>
          `<div class="review-ing-item">${i.amount} ${i.unit} ${i.name}</div>`
        ).join('')}
      </div>
    </div>
  `).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('builder-carbs')">‹ Back</button>
      <div class="logo"><span class="color-dot-header" style="background:${b.color}"></span>${b.name}</div>
      <div class="subtitle">${renderEmoji(b.cuisineEmoji)} ${b.cuisine} · ${b.steps.length} step${b.steps.length > 1 ? 's' : ''} · ${totalIngs} ingredients</div>
    </div>
    <div class="scroll-body">
      <div class="review-summary">
        <div class="review-carbs">Pairs with: ${pairedCarbs.map(c => c.emoji + ' ' + c.name).join(', ')}</div>
      </div>
      ${stepsPreview}
      ${b.error ? `<div class="builder-error">${b.error}</div>` : ''}
      <button class="builder-primary-btn" onclick="builderSave()" ${b.saving ? 'disabled' : ''}>
        ${b.saving ? '<span class="spinner-sm"></span> Saving…' : 'Save Sauce'}
      </button>
      <button class="builder-secondary-btn" onclick="navigate('builder')">Edit</button>
    </div>
  `;
}

function renderRecipe() {
  const sauce = state.selectedSauce;
  const carb = state.selectedCarb;
  const carbTotal = (carb.portionPerPerson || 100) * state.servings;
  const carbUnit = carb.portionUnit || 'g';

  // Build substitution banner for disabled ingredients
  const disabledInRecipe = sauce.ingredients
    .filter(i => state.disabledIngredients.has(i.name))
    .map(i => ({ name: i.name, sub: getSubstitutionText(i.name) }))
    .filter(i => i.sub);
  const subBannerHTML = disabledInRecipe.length > 0 ? `
    <div class="sub-banner">
      <strong>Ingredient swaps</strong>
      ${disabledInRecipe.map(i => `<div>${i.name} → <strong>${i.sub}</strong></div>`).join('')}
    </div>` : '';

  const stepsHTML = sauce.steps.map((step, i) => {
    const displayItems = prepareItems(step.ingredients);
    // If this step references a previous step, prepend its combined output as a single slice
    const refStep = step.inputFromStep ? sauce.steps[step.inputFromStep - 1] : null;
    if (refStep) {
      const refItems = prepareItems(refStep.ingredients);
      const refTotal = refItems.reduce((s, it) => s + it.amount, 0);
      const refUnit = refItems.length > 0 ? refItems[0].unit : 'tsp';
      displayItems.unshift({ name: `Step ${step.inputFromStep} output`, amount: refTotal, unit: refUnit });
    }
    const refBadge = refStep ? `<div class="step-ref-badge">⤶ Uses Step ${step.inputFromStep} output</div>` : '';
    return `<div class="step-card">
      <div class="step-number">Step ${i + 1}</div>
      <div class="step-title">${step.title}</div>
      ${refBadge}
      <div class="pie-container">
        ${buildPieChart(displayItems, 170)}
        <div class="legend">${buildLegend(displayItems)}</div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="recipe-header">
      <button class="back-btn" onclick="navigate('sauce-selector')">‹ Back</button>
      <div class="recipe-cuisine-badge">${renderEmoji(sauce.cuisineEmoji)} ${sauce.cuisine}</div>
      <div class="recipe-title">${sauce.name}</div>
      <div class="recipe-subtitle">Pair with: ${sauce.compatibleCarbs.join(', ')} &nbsp;·&nbsp; ${sauce.steps.length} step${sauce.steps.length > 1 ? 's' : ''}</div>
    </div>
    <div class="recipe-controls">
      <div class="serving-row">
        <div class="serving-info">
          <span class="serving-carb">${formatAmount(carbTotal)}${carbUnit} ${carb.name.toLowerCase()}</span>
          <span class="serving-for">for</span>
          <div class="serving-stepper">
            <button class="stepper-btn" onclick="setServings(state.servings - 1)">−</button>
            <span class="stepper-count">${state.servings}</span>
            <button class="stepper-btn" onclick="setServings(state.servings + 1)">+</button>
          </div>
          <span class="serving-for">people</span>
        </div>
        <div class="unit-toggle">
          <button class="toggle-btn ${state.unitSystem === 'imperial' ? 'active' : ''}" onclick="setUnitSystem('imperial')">Imperial</button>
          <button class="toggle-btn ${state.unitSystem === 'metric' ? 'active' : ''}" onclick="setUnitSystem('metric')">Metric</button>
        </div>
      </div>
    </div>
    <div class="scroll-body" style="padding:0">
      ${subBannerHTML}
      ${state.selectedPrep ? `
      <div class="prep-card">
        <div class="prep-card-header">
          <span class="prep-card-emoji">${state.selectedPrep.emoji || carb.emoji}</span>
          <div>
            <div class="prep-card-title">${state.selectedPrep.name}</div>
            <div class="prep-card-meta">${state.selectedPrep.cookTime || ''}${state.selectedPrep.waterRatio ? ' · ' + state.selectedPrep.waterRatio : ''}</div>
          </div>
        </div>
        <p class="prep-card-instructions">${state.selectedPrep.instructions || ''}</p>
      </div>` : ''}
      <div class="steps-container">
        ${stepsHTML}
      </div>
      <div class="tip-card">
        <strong>💡 How to read the chart</strong>
        Each slice shows the relative proportion of that ingredient. Bigger slice = more of it. Adjust the people count above to scale the recipe.
      </div>
    </div>
  `;
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'carb-selector':   app.innerHTML = renderCarbSelector(); break;
    case 'prep-selector':   app.innerHTML = renderPrepSelector(); break;
    case 'sauce-selector':  app.innerHTML = renderSauceSelector(); break;
    case 'recipe':          app.innerHTML = renderRecipe(); break;
    case 'builder':         app.innerHTML = renderBuilder(); break;
    case 'builder-carbs':   app.innerHTML = renderBuilderCarbs(); break;
    case 'builder-review':  app.innerHTML = renderBuilderReview(); break;
  }
}
function navigate(screen) { state.screen = screen; render(); }

// ─── Actions ──────────────────────────────────────────────────────────────────
async function selectCarb(id) {
  state.selectedCarb = state.carbs.find(c => c.id === id);
  state.servings = 2; // reset to default on new carb
  state.selectedPrep = null;
  // Show loading immediately while fetching sauces + ingredients + preparations
  document.getElementById('app').innerHTML = `
    <div class="loading-screen">
      <div class="spinner"></div>
      <p class="loading-text">Loading…</p>
    </div>`;
  try {
    const [sauces, ingredients, preps] = await Promise.all([
      fetchSaucesForCarb(id),
      fetchIngredientsForCarb(id),
      fetchPreparationsForCarb(id).catch(() => []),
    ]);
    state.saucesForCurrentCarb = sauces;
    state.allIngredients       = ingredients;
    state.preparations         = preps;
    state.disabledIngredients  = new Set();
    state.filterOpen           = false;
    state.expandedCuisines     = new Set([sauces[0]?.cuisine].filter(Boolean));
    // If preparations exist, show prep selector; otherwise skip to sauces
    state.screen = preps.length > 0 ? 'prep-selector' : 'sauce-selector';
    render();
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load: ${err.message}<br>
        <button onclick="navigate('carb-selector')" style="margin-top:1rem">‹ Back</button>
      </div>`;
  }
}
function selectPrep(id) {
  state.selectedPrep = state.preparations.find(p => p.id === id) || null;
  navigate('sauce-selector');
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
function setServings(n) {
  state.servings = Math.max(1, Math.min(12, n));
  render();
}
function setUnitSystem(sys) {
  state.unitSystem = sys;
  render();
}

// ─── Builder Actions ─────────────────────────────────────────────────────────
function openBuilder() {
  state.builder = defaultBuilder();
  navigate('builder');
}
function builderSetCuisine(name, emoji) {
  state.builder.cuisine = name;
  state.builder.cuisineEmoji = emoji;
  render();
}
function builderSetColor(hex) {
  state.builder.color = hex;
  render();
}
function builderAddStep() {
  state.builder.steps.push({ title: '', inputFromStep: null, ingredients: [{ name: '', amount: '', unit: 'tsp' }] });
  render();
}
function builderRemoveStep(si) {
  const removedOrder = si + 1; // 1-based step order being removed
  state.builder.steps.splice(si, 1);
  // Fix step references: clear if referencing removed step, decrement if referencing later step
  for (const step of state.builder.steps) {
    if (step.inputFromStep === removedOrder) {
      step.inputFromStep = null;
    } else if (step.inputFromStep > removedOrder) {
      step.inputFromStep--;
    }
  }
  render();
}
function builderAddIngredient(si) {
  state.builder.steps[si].ingredients.push({ name: '', amount: '', unit: 'tsp' });
  render();
}
function builderRemoveIngredient(si, ii) {
  state.builder.steps[si].ingredients.splice(ii, 1);
  render();
}
function builderToggleCarb(id) {
  const idx = state.builder.carbIds.indexOf(id);
  if (idx >= 0) state.builder.carbIds.splice(idx, 1);
  else state.builder.carbIds.push(id);
  render();
}
function builderHandleInput(el) {
  const field = el.dataset.builderField;
  const si = parseInt(el.dataset.step);
  const ii = parseInt(el.dataset.ing);
  const b = state.builder;
  switch (field) {
    case 'name': b.name = el.value; break;
    case 'step-title': b.steps[si].title = el.value; break;
    case 'ing-name': {
      b.steps[si].ingredients[ii].name = el.value;
      // Autocomplete: show fuzzy matches
      const matches = fuzzyMatchIngredients(el.value);
      b.acStep = si;
      b.acIng = ii;
      b.acResults = matches;
      b.acSelected = -1;
      // Update dropdown in-place without re-render
      updateAutocompleteDropdown(si, ii, matches);
      break;
    }
    case 'ing-amount': b.steps[si].ingredients[ii].amount = el.value; break;
    case 'ing-unit': b.steps[si].ingredients[ii].unit = el.value; break;
    case 'input-from-step': {
      b.steps[si].inputFromStep = el.value ? parseInt(el.value) : null;
      break;
    }
  }
  // Update continue button disabled state without full re-render
  const btn = document.querySelector('.builder-primary-btn');
  if (btn && state.screen === 'builder') {
    const canContinue = b.name.trim() && b.cuisine && b.steps.some(s => s.title.trim() && s.ingredients.some(i => i.name.trim() && i.amount));
    btn.disabled = !canContinue;
  }
}

// Update autocomplete dropdown without full re-render (preserves input focus)
function updateAutocompleteDropdown(si, ii, matches) {
  // Remove any existing dropdown
  document.querySelectorAll('.ac-dropdown').forEach(d => d.remove());
  if (matches.length === 0) return;
  const input = document.querySelector(`.ing-name[data-step="${si}"][data-ing="${ii}"]`);
  if (!input) return;
  const wrap = input.closest('.ing-name-wrap');
  if (!wrap) return;
  const dd = document.createElement('div');
  dd.className = 'ac-dropdown';
  dd.innerHTML = matches.map((name, idx) =>
    `<div class="ac-item" data-ac-pick="${name.replace(/"/g, '&quot;')}" data-step="${si}" data-ing="${ii}">${name}</div>`
  ).join('');
  wrap.appendChild(dd);
}

function builderPickAutocomplete(name, si, ii) {
  const b = state.builder;
  b.steps[si].ingredients[ii].name = name;
  b.acResults = [];
  b.acStep = null;
  b.acIng = null;
  // Update input value in-place
  const input = document.querySelector(`.ing-name[data-step="${si}"][data-ing="${ii}"]`);
  if (input) input.value = name;
  // Remove dropdown
  document.querySelectorAll('.ac-dropdown').forEach(d => d.remove());
}

function builderClassifyIngredient(si, ii, category) {
  const b = state.builder;
  const ing = b.steps[si].ingredients[ii];
  classifyIngredient(ing.name, category);
  ing._showCategory = false;
  // Remove the classification UI without full re-render
  const wrap = document.querySelector(`.ingredient-row-wrap:has([data-step="${si}"][data-ing="${ii}"].ing-name)`);
  if (wrap) {
    const classify = wrap.querySelector('.category-classify');
    if (classify) classify.remove();
  }
}
async function builderSave() {
  const b = state.builder;
  b.saving = true;
  b.error = null;
  render();
  try {
    const payload = {
      name: b.name.trim(),
      cuisine: b.cuisine,
      cuisineEmoji: b.cuisineEmoji,
      color: b.color,
      description: b.description,
      carbIds: b.carbIds,
      steps: b.steps
        .filter(s => s.title.trim())
        .map(s => ({
          title: s.title.trim(),
          inputFromStep: s.inputFromStep || null,
          ingredients: s.ingredients
            .filter(i => i.name.trim() && parseFloat(i.amount) > 0)
            .map(i => ({ name: i.name.trim(), amount: parseFloat(i.amount), unit: i.unit })),
        }))
        .filter(s => s.ingredients.length > 0),
    };
    await createSauce(payload);
    state.builder = null;
    navigate('carb-selector');
  } catch (err) {
    b.saving = false;
    b.error = err.message;
    render();
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [carbs, categoriesRaw, subsRaw] = await Promise.all([
      fetchCarbs(),
      fetchIngredientCategories().catch(() => []),
      fetchSubstitutions().catch(() => []),
    ]);
    state.carbs = carbs;

    // Build category lookup: name → category
    state.ingredientCategories = {};
    if (Array.isArray(categoriesRaw)) {
      for (const c of categoriesRaw) {
        state.ingredientCategories[c.ingredientName] = c.category;
      }
    }

    // Build substitution lookup: name → [{substituteName, notes}]
    state.substitutions = {};
    if (Array.isArray(subsRaw)) {
      for (const s of subsRaw) {
        if (!state.substitutions[s.ingredientName]) {
          state.substitutions[s.ingredientName] = [];
        }
        state.substitutions[s.ingredientName].push({
          substituteName: s.substituteName,
          notes: s.notes,
        });
      }
    }
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;text-align:center;color:#dc2626">
        Failed to load: ${err.message}
      </div>`;
    return;
  }
  render();

  // Delegated handler for ingredient chips (avoids fragile inline onclick escaping)
  const appEl = document.getElementById('app');
  appEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip[data-ingredient]');
    if (chip) toggleIngredient(chip.dataset.ingredient);
  });

  // Delegated input handler for builder fields (no re-render to preserve cursor)
  appEl.addEventListener('input', e => {
    if (e.target.dataset.builderField) builderHandleInput(e.target);
  });
  appEl.addEventListener('change', e => {
    if (e.target.dataset.builderField) builderHandleInput(e.target);
  });

  // Autocomplete: click to pick a suggestion
  appEl.addEventListener('mousedown', e => {
    const acItem = e.target.closest('.ac-item[data-ac-pick]');
    if (acItem) {
      e.preventDefault(); // prevent blur from firing first
      const si = parseInt(acItem.dataset.step);
      const ii = parseInt(acItem.dataset.ing);
      builderPickAutocomplete(acItem.dataset.acPick, si, ii);
    }
  });

  // Category classification: click to classify
  appEl.addEventListener('click', e => {
    const catChip = e.target.closest('.category-chip[data-classify-cat]');
    if (catChip) {
      const si = parseInt(catChip.dataset.step);
      const ii = parseInt(catChip.dataset.ing);
      builderClassifyIngredient(si, ii, catChip.dataset.classifyCat);
    }
  });

  // Ingredient name blur: dismiss autocomplete & trigger category classification if unknown
  appEl.addEventListener('focusout', e => {
    if (e.target.dataset.builderField === 'ing-name' && state.builder) {
      const si = parseInt(e.target.dataset.step);
      const ii = parseInt(e.target.dataset.ing);
      const b = state.builder;
      // Dismiss autocomplete after a short delay (allow click to register)
      setTimeout(() => {
        if (b.acStep === si && b.acIng === ii) {
          b.acResults = [];
          b.acStep = null;
          b.acIng = null;
          document.querySelectorAll('.ac-dropdown').forEach(d => d.remove());
        }
      }, 200);
      // Check if ingredient needs category classification
      const ing = b.steps[si]?.ingredients[ii];
      if (ing && ing.name.trim().length >= 2 && !isKnownIngredient(ing.name)) {
        ing._showCategory = true;
        // Insert category chips below this ingredient row
        const wrap = e.target.closest('.ingredient-row-wrap');
        if (wrap && !wrap.querySelector('.category-classify')) {
          const div = document.createElement('div');
          div.className = 'category-classify';
          div.innerHTML = `
            <span class="category-classify-label">Classify "${ing.name.trim()}":</span>
            <div class="category-chips">
              ${CATEGORY_ORDER.map(cat =>
                `<button class="category-chip" data-classify-cat="${cat}" data-step="${si}" data-ing="${ii}">${cat}</button>`
              ).join('')}
            </div>`;
          wrap.appendChild(div);
        }
      }
    }
  });
});
