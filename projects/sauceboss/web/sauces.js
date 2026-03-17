'use strict';

// Returns header context based on the current screen path.
function getSauceScreenContext() {
  if (state.screen === 'dressing-selector') {
    const base = state.selectedSaladBase;
    return {
      sauces: state.dressingsForCurrentBase,
      backScreen: 'salad-base-selector',
      emoji: base ? base.emoji : '🥗',
      title: base ? `${base.name} Dressings` : 'Dressings',
      compatLabel: (s) => s.compatibleBases ? s.compatibleBases.join(' · ') : '',
    };
  }
  if (state.screen === 'marinade-selector') {
    const protein = state.selectedProtein;
    return {
      sauces: state.marinadesForCurrentProtein,
      backScreen: 'protein-selector',
      emoji: protein ? protein.emoji : '🔥',
      title: protein ? `${protein.name} Marinades` : 'Marinades',
      compatLabel: (s) => s.compatibleProteins ? s.compatibleProteins.join(' · ') : '',
    };
  }
  // Default: sauces path
  const carb = state.selectedCarb;
  return {
    sauces: state.saucesForCurrentCarb,
    backScreen: 'protein-veggie-selector',
    emoji: carb ? carb.emoji : '🍲',
    title: carb ? `${carb.name} Sauces` : 'Sauces',
    compatLabel: (s) => s.compatibleCarbs ? s.compatibleCarbs.join(' · ') : '',
  };
}

function renderSauceSelector() {
  const ctx = getSauceScreenContext();
  const { sauces } = ctx;
  const cuisines = [...new Set(sauces.map(s => s.cuisine))];
  const missingCount = state.disabledIngredients.size;
  const categoryGroups = groupIngredientsByCategory();

  const chipHTML = (items) => items.map(({ name }) => {
    const has = !state.disabledIngredients.has(name);
    return `<button class="chip ${has ? 'has' : 'missing'}" data-ingredient="${name.replace(/"/g, '&quot;')}">
      <i data-lucide="${has ? 'check' : 'x'}"></i> ${name}
    </button>`;
  }).join('');

  const filterBody = `
    <div class="filter-body ${state.filterOpen ? 'open' : ''}">
      <p class="filter-hint">Uncheck ingredients you don't have — options will update.</p>
      ${categoryGroups.map(({ category, items, isKey }) => `
        <div class="ingredient-section${isKey ? ' key-section' : ''}">
          <p class="ingredient-section-label">
            ${isKey ? '<span class="section-label-icon"><i data-lucide="star"></i></span>' : ''}${category}
            ${isKey ? '<span class="section-label-detail">— unlock the most options</span>' : ''}
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
      const compatText = ctx.compatLabel(sauce);
      return `<div class="sauce-item ${available ? '' : 'unavailable'}" onclick="selectSauce('${sauce.id}')">
        <span class="sauce-dot" style="background:${sauce.color}"></span>
        <div class="sauce-info">
          <div class="sauce-item-name">${sauce.name}</div>
          <div class="sauce-item-tags">${compatText}${missing.length ? ' · missing: '+missingText : ''}</div>
        </div>
        ${!available ? `<span class="sauce-missing-badge">-${missing.length}</span>` : ''}
        <span class="sauce-arrow"><i data-lucide="chevron-right"></i></span>
      </div>`;
    }).join('');

    return `<div class="cuisine-group ${isOpen ? 'open' : ''}" id="cg-${cuisine}">
      <button class="cuisine-header" onclick="toggleCuisine('${cuisine}')">
        <span class="cuisine-flag">${emoji}</span>
        <span class="cuisine-name">${cuisine}</span>
        <span class="cuisine-count">${availCount}/${cuisineSauces.length}</span>
        <span class="cuisine-chevron"><i data-lucide="chevron-down"></i></span>
      </button>
      <div class="sauce-list">${saucesHTML}</div>
    </div>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('${ctx.backScreen}')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>${ctx.emoji}</span>${ctx.title}</div>
      <div class="subtitle">${sauces.length} options · select your style</div>
    </div>
    <div class="scroll-body">
      <p class="section-label">Ingredient filter</p>
      <div class="filter-panel">
        <button class="filter-header" onclick="toggleFilter()">
          <span class="filter-header-text"><i data-lucide="shopping-basket"></i> My Pantry${missingCount > 0 ? `<span class="filter-count">−${missingCount} hidden</span>` : ''}</span>
          <span class="filter-chevron ${state.filterOpen ? 'open' : ''}"><i data-lucide="chevron-down"></i></span>
        </button>
        ${filterBody}
      </div>
      <p class="section-label">Pick a recipe</p>
      ${accordionHTML}
    </div>
  `;
}

function selectSauce(id) {
  const { sauces } = getSauceScreenContext();
  state.selectedSauce = sauces.find(s => s.id === id);

  if (state.mealStep === 'carb') {
    state.meal.carb     = state.selectedCarb;
    state.meal.prep     = state.selectedPrep;
    state.meal.sauce    = state.selectedSauce;
    state.mealStep = null;
    navigate('meal-builder');
  } else if (state.mealStep === 'salad') {
    state.meal.saladBase = state.selectedSaladBase;
    state.meal.dressing  = state.selectedSauce;
    state.mealStep = null;
    navigate('meal-builder');
  } else if (state.mealStep === 'protein') {
    state.meal.protein  = state.selectedProtein;
    state.meal.marinade = state.selectedSauce;
    state.mealStep = null;
    navigate('meal-builder');
  } else {
    navigate('recipe');
  }
}

function toggleFilter() {
  state.filterOpen = !state.filterOpen;
  render();
}

function toggleIngredient(name) {
  if (state.disabledIngredients.has(name)) state.disabledIngredients.delete(name);
  else state.disabledIngredients.add(name);
  render();
}

function toggleCuisine(name) {
  if (state.expandedCuisines.has(name)) state.expandedCuisines.delete(name);
  else state.expandedCuisines.add(name);
  render();
}
