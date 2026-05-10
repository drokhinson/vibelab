'use strict';

// ─── New saucebook-driven meal flow ─────────────────────────────────────────
// Entry point: chef's-hat FAB on the Saucebook tab. Three steps:
//   1. category (carb / protein / salad)
//   2. dish + optional subtype (accordion of state.carbs / state.proteins /
//      state.saladBases — the get_sauceboss_initial_load RPC now nests
//      `subtypes` under each dish row)
//   3. sauce — reuses the existing renderSauceSelector, but the sauce list
//      is the intersection of state.saucebook and sauces matching the
//      picked target (category-level + dish-level + subtype-level + parent-
//      dish-level for subtypes, mirroring get_sauceboss_sauces_for_target).

const MEAL_CATEGORY_OPTIONS = [
  { id: 'carb',    label: 'Carbs',    emoji: '🍚', icon: 'wheat',     listKey: 'carbs'      },
  { id: 'protein', label: 'Proteins', emoji: '🍗', icon: 'drumstick', listKey: 'proteins'   },
  { id: 'salad',   label: 'Salads',   emoji: '🥗', icon: 'salad',     listKey: 'saladBases' },
];

async function startMealBuilder() {
  if (!currentUser) { openAuthModal(); return; }
  state.mealFlow = { category: null, dish: null, subtype: null };
  state.expandedParents = {};
  navigate('meal-category');
  // Lazy-load the dish lists + ref data the moment the meal-builder opens.
  // They're cached after first load, so re-entering the flow is instant.
  if (!state.carbs.length || !_hasBuilderRefData()) {
    await withInlineLoader(Promise.all([
      ensureItemLists(),
      ensureBuilderRefData(),
    ]));
  }
}

function renderMealCategory() {
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="setActiveTab('saucebook')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo">Build a Meal</div>
      <div class="subtitle">What are you cooking?</div>
    </div>
    <div class="scroll-body">
      <div class="carb-grid">
        ${MEAL_CATEGORY_OPTIONS.map((c, i) => `
          <button class="carb-card" style="--i:${i}" onclick="mealPickCategory('${c.id}')">
            <span class="carb-emoji">${c.emoji}</span>
            <div class="carb-name">${c.label}</div>
            <div class="carb-desc">Pick a ${c.label.slice(0, -1).toLowerCase()} dish</div>
          </button>`).join('')}
      </div>
    </div>
  `;
}

function mealPickCategory(id) {
  state.mealFlow.category = id;
  state.mealFlow.dish = null;
  state.mealFlow.subtype = null;
  navigate('meal-dish');
}

function renderMealDish() {
  const cat = state.mealFlow.category;
  const opt = MEAL_CATEGORY_OPTIONS.find(o => o.id === cat) || MEAL_CATEGORY_OPTIONS[0];
  const dishes = state[opt.listKey] || [];
  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-category')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo">${opt.label}</div>
      <div class="subtitle">Pick a dish (or a subtype) to pair with a sauce.</div>
    </div>
    <div class="scroll-body">
      ${dishes.length === 0
        ? `<div class="empty-state">No ${opt.label.toLowerCase()} configured.</div>`
        : dishes.map(_renderMealDishRow).join('')}
    </div>
  `;
}

function _renderMealDishRow(dish) {
  const subtypes = Array.isArray(dish.subtypes) ? dish.subtypes : (dish.variants || []);
  const isOpen = !!state.expandedParents[dish.id];
  const hasSubtypes = subtypes.length > 0;
  return `
    <div class="recipe-row" style="display:block;cursor:default">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="recipe-row__color" style="background:#FFF3E6;font-size:24px;display:flex;align-items:center;justify-content:center">${dish.emoji || '🍽'}</span>
        <div class="recipe-row__main">
          <div class="recipe-row__name">${escapeHtml(dish.name)}</div>
          <div class="recipe-row__meta">
            ${dish.description ? `<span class="recipe-row__author">${escapeHtml(dish.description)}</span>` : ''}
          </div>
        </div>
        <button class="recipe-row__action" onclick="mealPickDish('${escapeHtml(dish.id)}')">Pick</button>
        ${hasSubtypes ? `
          <button class="recipe-row__action" style="margin-left:6px" onclick="mealToggleDishExpand('${escapeHtml(dish.id)}')">
            ${isOpen ? '−' : '+'} ${subtypes.length}
          </button>
        ` : ''}
      </div>
      ${isOpen && hasSubtypes ? `
        <div style="margin-top:10px;padding-left:12px;border-left:3px solid #F1E0CC">
          ${subtypes.map(sub => `
            <div class="recipe-row" onclick="mealPickSubtype('${escapeHtml(dish.id)}', '${escapeHtml(sub.id)}')" style="margin-bottom:6px">
              <span class="recipe-row__color" style="background:#FFFBF5;font-size:18px;display:flex;align-items:center;justify-content:center">${sub.emoji || '·'}</span>
              <div class="recipe-row__main">
                <div class="recipe-row__name">${escapeHtml(sub.name)}</div>
              </div>
              <span class="recipe-row__action recipe-row__action--added">Pick</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function mealToggleDishExpand(dishId) {
  state.expandedParents[dishId] = !state.expandedParents[dishId];
  render();
}

function mealPickDish(dishId) {
  const cat = state.mealFlow.category;
  const list = state[(MEAL_CATEGORY_OPTIONS.find(o => o.id === cat) || MEAL_CATEGORY_OPTIONS[0]).listKey] || [];
  const dish = list.find(d => d.id === dishId);
  if (!dish) return;
  state.mealFlow.dish = dish;
  state.mealFlow.subtype = null;
  _proceedToSauceSelector(dish, null);
}

function mealPickSubtype(dishId, subtypeId) {
  const cat = state.mealFlow.category;
  const list = state[(MEAL_CATEGORY_OPTIONS.find(o => o.id === cat) || MEAL_CATEGORY_OPTIONS[0]).listKey] || [];
  const dish = list.find(d => d.id === dishId);
  if (!dish) return;
  const subs = Array.isArray(dish.subtypes) ? dish.subtypes : (dish.variants || []);
  const subtype = subs.find(s => s.id === subtypeId);
  if (!subtype) return;
  state.mealFlow.dish = dish;
  state.mealFlow.subtype = subtype;
  _proceedToSauceSelector(dish, subtype);
}

function _proceedToSauceSelector(dish, subtype) {
  // Set the legacy state shape so the existing sauce-selector + meal-recipe
  // renderers work without changes:
  //   selectedItem  = the dish (always — it's the "main" item in the recipe)
  //   selectedPrep  = the subtype (optional; renderers already treat it as
  //                   an override for cookTime / instructions)
  state.selectedItem = dish;
  state.selectedPrep = subtype || null;
  state.preparations = Array.isArray(dish.subtypes) ? dish.subtypes : (dish.variants || []);

  // Filter saucebook → sauces compatible with this target. Doing it client-
  // side avoids an extra round-trip — the saucebook envelopes already carry
  // `attachments`, and the target spec is small.
  const target = {
    category: state.mealFlow.category,
    dishId: dish.id,
    subtypeId: subtype ? subtype.id : null,
    subtypeParentId: subtype ? (subtype.parentId || dish.id) : null,
  };
  const matches = (state.saucebook || []).filter(s => _attachmentsMatchTarget(s.attachments || [], target));
  state.saucesForCurrentItem = matches;
  // Also seed allIngredients (used by the ingredient filter). Saucebook
  // envelopes are slim — read the pre-built `ingredientNames` Set rather
  // than the (no-longer-present) `ingredients[]` array.
  const seen = new Set();
  for (const s of matches) {
    if (s.ingredientNames instanceof Set) {
      for (const name of s.ingredientNames) seen.add(name);
    }
  }
  state.allIngredients = [...seen].sort();
  state.recipeReturnTo = 'tab-shell';
  // Open the pantry filter by default in the meal flow so the user sees
  // their pantry-missing items pre-toggled and can flip any of them
  // without a hidden interaction.
  state.filterOpen = true;
  navigate('sauce-selector');
}

function _attachmentsMatchTarget(attachments, target) {
  for (const a of attachments) {
    if (a.kind === 'category' && a.value === target.category) return true;
    if (a.kind === 'dish'     && a.value === target.dishId) return true;
    if (a.kind === 'subtype'  && target.subtypeId && a.value === target.subtypeId) return true;
    if (a.kind === 'dish'     && target.subtypeParentId && a.value === target.subtypeParentId) return true;
  }
  return false;
}


// ─── Meal Builder home — single-pick across three sections ──────────────────

// Shared pot illustration. Rendered both on the splash (in index.html) and
// as the hero illustration on the meal-builder home; class names below let
// CSS animate the steam and wiggle the pot during loading.
function potSVG() {
  return `
    <svg class="pot-svg" width="180" height="140" viewBox="0 0 180 140" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="90" cy="130" rx="62" ry="8" fill="#1A1A2E" opacity="0.06"/>
      <path d="M28 68 Q28 112 90 112 Q152 112 152 68 Z" fill="#FFF3E6"/>
      <path d="M28 68 Q28 112 90 112 Q152 112 152 68" stroke="#C94E02" stroke-width="2" fill="none"/>
      <ellipse cx="90" cy="96" rx="40" ry="10" fill="#E85D04" opacity="0.1"/>
      <circle class="steam-circle steam-circle--1" cx="70"  cy="91"  r="9" fill="#E85D04" opacity="0.85"/>
      <circle class="steam-circle steam-circle--2" cx="93"  cy="84"  r="7" fill="#F48C06" opacity="0.9"/>
      <circle class="steam-circle steam-circle--3" cx="114" cy="93"  r="8" fill="#C94E02" opacity="0.85"/>
      <circle class="steam-circle steam-circle--4" cx="82"  cy="103" r="5" fill="#FAA307" opacity="0.9"/>
      <path d="M58 76 Q72 62 88 76 Q104 90 118 74" stroke="#E85D04" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.5"/>
      <rect x="20" y="60" width="140" height="14" rx="7" fill="#3D1100"/>
      <path class="steam-trail steam-trail--1" d="M62 56 Q66 44 62 34 Q58 24 62 14"     stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path class="steam-trail steam-trail--2" d="M90 53 Q94 41 90 31 Q86 21 90 11"     stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <path class="steam-trail steam-trail--3" d="M118 56 Q122 44 118 34 Q114 24 118 14" stroke="#D1D5DB" stroke-width="2.5" stroke-linecap="round" fill="none"/>
    </svg>`;
}

const MEAL_TABS = [
  { id: 'carbs',    label: 'Carbs',    icon: 'wheat'     },
  { id: 'proteins', label: 'Proteins', icon: 'drumstick' },
  { id: 'salads',   label: 'Salads',   icon: 'salad'     },
];

function mealTabItems(id) {
  if (id === 'proteins') return state.proteins;
  if (id === 'salads')   return state.saladBases;
  return state.carbs;
}

function mealCategoryItemCard(item, i) {
  return `
    <button class="carb-card" style="--i:${i}" onclick="selectItem('${item.id}')">
      <span class="carb-emoji">${item.emoji}</span>
      <div class="carb-name">${item.name}</div>
      <div class="carb-desc">${item.description || ''}</div>
    </button>`;
}

function mealCategoryContent(id) {
  const items = mealTabItems(id);
  if (!items || !items.length) {
    const label = (MEAL_TABS.find(t => t.id === id) || MEAL_TABS[0]).label.toLowerCase();
    return `<div class="empty-state">No ${label} yet.</div>`;
  }
  return `<div class="carb-grid">${items.map(mealCategoryItemCard).join('')}</div>`;
}

function renderMealBuilder() {
  const heroSVG = `<div class="hero-illustration" id="hero-illustration">${potSVG()}</div>`;
  const activeId = MEAL_TABS.some(t => t.id === state.mealCategory) ? state.mealCategory : 'carbs';

  const tabsHTML = `
    <div class="cat-tabs" role="tablist" aria-label="Meal category">
      ${MEAL_TABS.map(t => `
        <button class="cat-tab ${t.id === activeId ? 'cat-tab--active' : ''}"
                role="tab"
                data-tab-id="${t.id}"
                aria-selected="${t.id === activeId}"
                onclick="setMealCategory('${t.id}')">
          <i data-lucide="${t.icon}"></i>
          <span>${t.label}</span>
        </button>`).join('')}
    </div>`;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <div class="logo">SauceBoss</div>
      <div class="subtitle">What are you cooking with?</div>
      ${renderHeaderAuthSlot()}
      <button class="sauce-mgr-btn" onclick="openSauceManager()" aria-label="Sauce manager">
        <i data-lucide="chef-hat"></i><span>Sauces</span>
      </button>
    </div>
    <div class="scroll-body">
      ${heroSVG}
      ${tabsHTML}
      <div id="cat-content">${mealCategoryContent(activeId)}</div>
    </div>
  `;
}

// Tab switch updates only the tabs' active class and the grid contents —
// the orange header and the pot illustration aren't touched, so the logo
// doesn't blink.
function setMealCategory(id) {
  if (state.mealCategory === id) return;
  if (!MEAL_TABS.some(t => t.id === id)) return;
  state.mealCategory = id;

  const tabButtons = document.querySelectorAll('.cat-tab');
  if (!tabButtons.length) { render(); return; }
  tabButtons.forEach(btn => {
    const isActive = btn.dataset.tabId === id;
    btn.classList.toggle('cat-tab--active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const contentEl = document.getElementById('cat-content');
  if (contentEl) contentEl.innerHTML = mealCategoryContent(id);

  if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
}

// ─── Unified Meal Recipe screen ───────────────────────────────────────────────

function renderMealRecipe() {
  const { meal } = state;
  if (!meal.item || !meal.sauce) return '';
  const item  = meal.item;
  const prep  = meal.prep;
  const sauce = meal.sauce;
  const meta  = flowMetaFor(item);

  // ── Timing summary ───────────────────────────────────────────────────────────
  const sauceTime = sauce.steps.reduce(
    (s, st) => s + (st.estimatedTime || 5), 0,
  );
  const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
  const totalTime = sauceTime + itemCookTime;
  const isMarinade = sauce.sauceType === 'marinade';
  const marineAhead = isMarinade && sauceTime > 20;

  const timingBanner = `
    <div class="meal-timing-banner">
      <div class="meal-timing-total"><i data-lucide="clock"></i> Total: ~${totalTime} min active</div>
      ${marineAhead ? `<div class="meal-timing-note"><i data-lucide="triangle-alert"></i> Start marinade ${sauceTime}+ min before you cook</div>` : ''}
    </div>`;

  // ── Sauce/marinade/dressing steps ────────────────────────────────────────────
  function sauceStepsHTML(sauceObj) {
    return sauceObj.steps.map((step, i) => {
      const stepTime = step.estimatedTime || 5;
      const displayItems = prepareItems(step.ingredients);

      const refStep = step.inputFromStep ? sauceObj.steps[step.inputFromStep - 1] : null;
      if (refStep) {
        const refTsp = cumulativeStepTsp(sauceObj.steps, step.inputFromStep - 1, state.servings);
        const disp = tspToDisplay(refTsp);
        displayItems.unshift({ name: `Step ${step.inputFromStep} combined`, amount: disp.amount, unit: disp.unit });
      }
      const refBadge = refStep
        ? `<div class="step-ref-badge"><i data-lucide="corner-down-right"></i> Combine all of Step ${step.inputFromStep} into this bowl</div>` : '';

      return `<div class="step-card">
        <div class="step-header-row">
          <div class="step-number">Step ${i + 1}</div>
          <div class="step-time">~${stepTime}m</div>
        </div>
        <div class="step-title">${step.title}</div>
        ${step.instructions ? `
          <details class="step-instructions-toggle">
            <summary>Instructions</summary>
            <p class="step-instructions-body">${escapeHtml(step.instructions)}</p>
          </details>` : ''}
        ${refBadge}
        <div class="step-viz">
          ${buildPieChart(displayItems, 80)}
          <div class="step-legend">${buildLegend(displayItems)}</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Section colour by sauce_type ────────────────────────────────────────────
  const sauceColor = isMarinade ? '#5D4037'
                   : sauce.sauceType === 'dressing' ? '#1B5E20'
                   : '#4A0072';
  const sauceLabel = `${meta.sauceWord} — ${sauce.name}`;

  // ── Item prep section (one card describing how to cook the chosen item) ────
  const itemPrepLabel = item.category === 'salad'
    ? `🥗 Toss ${item.name}`
    : `${item.emoji} ${item.category === 'protein' ? 'Cook' : 'Prep'} ${item.name}${prep ? ` — ${prep.name}` : ''}`;
  const itemColor = item.category === 'protein' ? '#C94E02'
                 : item.category === 'salad'   ? '#2D6A4F'
                 : '#1565C0';
  const itemInstructions = prep?.instructions
                        || item.instructions
                        || (item.category === 'salad'
                            ? `Toss ${item.name} with ${sauce.name} right before serving`
                            : `Cook ${item.name} per packet instructions`);
  const itemCard = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${itemColor}">${itemPrepLabel}</div>
      <div class="step-card">
        <div class="step-header-row">
          <div class="step-number">${item.category === 'protein' ? 'Cook' : item.category === 'salad' ? 'Assemble' : 'Boil / prep'}</div>
          ${itemCookTime ? `<div class="step-time">~${itemCookTime}m</div>` : ''}
        </div>
        <div class="step-title">${itemInstructions}</div>
      </div>
    </div>`;

  const servingsHTML = `
    <div class="recipe-controls">
      <div class="servings-control">
        <button onclick="changeServings(-1)" class="serving-btn" ${state.servings <= 1 ? 'disabled' : ''}>−</button>
        <span class="servings-label">${state.servings} ${state.servings === 1 ? 'person' : 'people'}</span>
        <button onclick="changeServings(1)" class="serving-btn" ${state.servings >= 12 ? 'disabled' : ''}>+</button>
      </div>
      <button class="unit-toggle" onclick="toggleUnit()">
        ${state.unitSystem === 'imperial' ? 'Imperial' : 'Metric'}
      </button>
    </div>`;

  const title = `${prep?.name || item.name} with ${sauce.name}`;

  const family = state.selectedSauceFamily || [];
  const variantSwitcherHTML = family.length > 1 ? `
    <div class="variant-switcher" role="tablist" aria-label="Switch variant">
      ${family.map(s => `
        <button class="variant-chip ${s.id === sauce.id ? 'variant-chip--active' : ''}"
                role="tab"
                aria-selected="${s.id === sauce.id}"
                onclick="selectVariant('${s.id}')">
          ${escapeHtml(s.name)}${!s.parentSauceId ? '<span class="variant-chip-tag">original</span>' : ''}
        </button>
      `).join('')}
    </div>` : '';

  // For marinades, show marinade BEFORE cooking; otherwise item prep first.
  const sauceSection = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${sauceColor}">${sauceLabel}</div>
      ${sauceStepsHTML(sauce)}
    </div>`;

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('meal-builder')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>${item.emoji}</span>${title}</div>
      <div class="subtitle">${sauce.cuisine || 'Full recipe'}</div>
      ${renderHeaderAuthSlot()}
    </div>
    <div class="scroll-body">
      ${timingBanner}
      ${variantSwitcherHTML}
      ${(currentUser && state.editMode) ? `
        <div class="recipe-export-row">
          <a class="recipe-export-btn"
             href="${API}/api/v1/sauceboss/sauces/${encodeURIComponent(sauce.id)}/export.json"
             download>
            <i data-lucide="file-json-2"></i> Export JSON
          </a>
          <a class="recipe-export-btn"
             href="${API}/api/v1/sauceboss/sauces/${encodeURIComponent(sauce.id)}/export.md"
             download>
            <i data-lucide="file-text"></i> Export Markdown
          </a>
        </div>` : ''}
      ${servingsHTML}
      ${isMarinade ? sauceSection + itemCard : itemCard + sauceSection}
    </div>
  `;
}

// ─── Meal-recipe serving controls ─────────────────────────────────────────────
// (re-uses setServings / setUnitSystem from recipe.js)

function changeServings(delta) {
  setServings(state.servings + delta);
}

function toggleUnit() {
  setUnitSystem(state.unitSystem === 'imperial' ? 'metric' : 'imperial');
}
