'use strict';

// ─── Saucebook-driven meal flow ─────────────────────────────────────────────
// Entry point: chef's-hat FAB on the Saucebook tab. The home screen is one
// tabbed view (Carbs / Proteins / Salads) over the SauceBoss logo and pot
// hero. Picking a dish either drops straight into the sauce selector or, if
// the dish has subtypes, opens the subtype picker first. The sauce list is
// the client-side intersection of state.saucebook and sauces attached at
// category / dish / subtype / parent-dish-of-subtype level (mirrors
// get_sauceboss_sauces_for_target).

const MEAL_CATEGORY_OPTIONS = [
  { id: 'carb',    label: 'Carbs',    icon: 'wheat',     listKey: 'carbs'      },
  { id: 'protein', label: 'Proteins', icon: 'drumstick', listKey: 'proteins'   },
  { id: 'salad',   label: 'Salads',   icon: 'salad',     listKey: 'saladBases' },
];

async function startMealBuilder() {
  if (!currentUser) { openAuthModal(); return; }
  const prevCat = state.mealFlow && state.mealFlow.category;
  state.mealFlow = {
    category: MEAL_CATEGORY_OPTIONS.some(c => c.id === prevCat) ? prevCat : 'carb',
    dish: null,
    subtype: null,
  };
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
  const activeId = MEAL_CATEGORY_OPTIONS.some(c => c.id === state.mealFlow?.category)
    ? state.mealFlow.category
    : 'carb';
  state.mealFlow.category = activeId;

  const tabsHTML = `
    <div class="cat-tabs" role="tablist" aria-label="Meal category">
      ${MEAL_CATEGORY_OPTIONS.map(c => `
        <button class="cat-tab ${c.id === activeId ? 'cat-tab--active' : ''}"
                role="tab"
                data-tab-id="${c.id}"
                aria-selected="${c.id === activeId}"
                onclick="mealPickCategory('${c.id}')">
          <i data-lucide="${c.icon}"></i>
          <span>${c.label}</span>
        </button>`).join('')}
    </div>`;

  return `
    ${renderAppHeader({
      title: 'Meal Builder',
      subtitle: "What are you cooking with?",
      back: { onClick: "setActiveTab('saucebook')" },
    })}
    <div class="scroll-body scroll-body--padded">
      <div class="hero-illustration" id="hero-illustration">${potSVG()}</div>
      ${tabsHTML}
      <div id="cat-content">${_mealDishGridHTML(activeId)}</div>
    </div>
  `;
}

function _mealDishGridHTML(categoryId) {
  const opt = MEAL_CATEGORY_OPTIONS.find(o => o.id === categoryId) || MEAL_CATEGORY_OPTIONS[0];
  const dishes = state[opt.listKey] || [];
  if (!dishes.length) {
    return `<div class="empty-state">No ${opt.label.toLowerCase()} yet.</div>`;
  }
  return `<div class="carb-grid">${dishes.map((d, i) => {
    const subs = Array.isArray(d.subtypes) ? d.subtypes : (d.variants || []);
    return `
    <button class="carb-card" style="--i:${i}" onclick="mealPickDish('${escapeHtml(d.id)}')">
      <span class="carb-emoji">${d.emoji || '🍽'}</span>
      <div class="carb-name">${escapeHtml(d.name)}</div>
      ${subs.length > 0 ? `<div class="carb-desc">${subs.length} subtype${subs.length === 1 ? '' : 's'}</div>` :
        (d.description ? `<div class="carb-desc">${escapeHtml(d.description)}</div>` : '')}
    </button>`;
  }).join('')}</div>`;
}

// Tab-only swap so the SauceBoss logo + pot illustration don't blink.
function mealPickCategory(id) {
  if (!MEAL_CATEGORY_OPTIONS.some(c => c.id === id)) return;
  if (state.mealFlow.category === id) return;
  state.mealFlow.category = id;
  state.mealFlow.dish = null;
  state.mealFlow.subtype = null;

  const tabButtons = document.querySelectorAll('.cat-tab');
  if (!tabButtons.length) { render(); return; }
  tabButtons.forEach(btn => {
    const isActive = btn.dataset.tabId === id;
    btn.classList.toggle('cat-tab--active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  const contentEl = document.getElementById('cat-content');
  if (contentEl) contentEl.innerHTML = _mealDishGridHTML(id);
  if (window.lucide) requestAnimationFrame(() => lucide.createIcons());
}

function mealPickDish(dishId) {
  const cat = state.mealFlow.category;
  const opt = MEAL_CATEGORY_OPTIONS.find(o => o.id === cat) || MEAL_CATEGORY_OPTIONS[0];
  const list = state[opt.listKey] || [];
  const dish = list.find(d => d.id === dishId);
  if (!dish) return;
  state.mealFlow.dish = dish;
  state.mealFlow.subtype = null;
  const subs = Array.isArray(dish.subtypes) ? dish.subtypes : (dish.variants || []);
  if (subs.length > 0) {
    navigate('meal-subtype');
    return;
  }
  _proceedToSauceSelector(dish, null);
}

function renderMealSubtype() {
  const dish = state.mealFlow.dish;
  if (!dish) return '';
  const subs = Array.isArray(dish.subtypes) ? dish.subtypes : (dish.variants || []);
  return `
    ${renderAppHeader({
      title: 'Meal Builder',
      subtitle: `What type of ${escapeHtml(dish.name.toLowerCase())}?`,
      back: { onClick: "navigate('meal-category')" },
    })}
    <div class="scroll-body scroll-body--padded">
      <div class="carb-grid">
        <button class="carb-card" style="--i:0" onclick="mealPickSubtype(null)">
          <span class="carb-emoji">${dish.emoji || '🍽'}</span>
          <div class="carb-name">Just ${escapeHtml(dish.name)}</div>
          <div class="carb-desc">No subtype</div>
        </button>
        ${subs.map((s, i) => `
          <button class="carb-card" style="--i:${i + 1}" onclick="mealPickSubtype('${escapeHtml(s.id)}')">
            <span class="carb-emoji">${s.emoji || dish.emoji || '·'}</span>
            <div class="carb-name">${escapeHtml(s.name)}</div>
            ${s.cookTimeMinutes ? `<div class="carb-desc">${s.cookTimeMinutes} min</div>` : ''}
          </button>`).join('')}
      </div>
    </div>
  `;
}

function mealPickSubtype(subtypeId) {
  const dish = state.mealFlow.dish;
  if (!dish) return;
  if (!subtypeId) {
    state.mealFlow.subtype = null;
    _proceedToSauceSelector(dish, null);
    return;
  }
  const subs = Array.isArray(dish.subtypes) ? dish.subtypes : (dish.variants || []);
  const subtype = subs.find(s => s.id === subtypeId);
  if (!subtype) return;
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

// ─── Unified Meal Recipe screen ───────────────────────────────────────────────

function renderMealRecipe() {
  const { meal } = state;
  if (!meal.item || !meal.sauce) return '';
  const item  = meal.item;
  const prep  = meal.prep;
  const sauce = meal.sauce;
  const meta  = flowMetaFor(item);

  const sauceTime = sauce.steps.reduce((s, st) => s + (st.estimatedTime || 5), 0);
  const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
  const totalTime = sauceTime + itemCookTime;
  const isMarinade = sauce.sauceType === 'marinade';
  const marineAhead = isMarinade && sauceTime > 20;

  const timingBanner = `
    <div class="meal-timing-banner">
      <div class="meal-timing-total"><i data-lucide="clock"></i> Total: ~${totalTime} min active</div>
      ${marineAhead ? `<div class="meal-timing-note"><i data-lucide="triangle-alert"></i> Start marinade ${sauceTime}+ min before you cook</div>` : ''}
    </div>`;

  const sauceColor = isMarinade ? '#5D4037'
                   : sauce.sauceType === 'dressing' ? '#1B5E20'
                   : '#4A0072';
  const sauceLabel = `${meta.sauceWord} — ${sauce.name}`;
  const sauceSection = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${sauceColor}">${sauceLabel}</div>
      ${sauce.steps.map((step, i) => renderRecipeStep(step, i, sauce.steps)).join('')}
    </div>`;

  const title = `${prep?.name || item.name} with ${sauce.name}`;

  return `
    ${renderAppHeader({
      title,
      subtitle: sauce.cuisine || 'Full recipe',
      titleEmoji: item.emoji,
      back: { onClick: "navigate('meal-category')" },
    })}
    <div class="scroll-body scroll-body--padded">
      ${timingBanner}
      ${renderVariantSwitcher(sauce.id)}
      ${renderRecipeControls()}
      ${renderItemPrepBlock(item, prep, sauce)}
      ${sauceSection}
    </div>
  `;
}
