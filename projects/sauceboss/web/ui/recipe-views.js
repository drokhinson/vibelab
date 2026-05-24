'use strict';

// Shared recipe-view renderers. Powers the unified recipe layout
// (recipe.js → renderRecipe) used by both the meal builder and standalone
// views (browse, saucebook, admin sauce manager). The styling mirrors the
// React Native ServingsControl + UnitToggle so web and mobile stay in
// lockstep.
//
// Depends on these helpers.js-resident globals:
//   - aggregateSauceIngredients, prepareItems, QUALITATIVE_UNITS,
//     formatAmount, escapeHtml (formatting)
//   - cumulativeStepTsp, tspToDisplay (per-step input-from-step refs)
//   - buildPieChart, buildLegend (visual)
//   - state, render (re-render hook for toggleRecipeIngredients)
// All of those still live in helpers.js — see PR 13's domain/ extraction
// for the next step in this carve-out.

function renderRecipeControls() {
  const s = state.servings;
  return `
    <div class="recipe-controls">
      <div class="servings-control">
        <button onclick="setServings(state.servings - 1)" class="serving-btn" ${s <= 1 ? 'disabled' : ''}>−</button>
        <span class="servings-label">${s} ${s === 1 ? 'serving' : 'servings'}</span>
        <button onclick="setServings(state.servings + 1)" class="serving-btn" ${s >= 12 ? 'disabled' : ''}>+</button>
      </div>
      <button class="unit-toggle" onclick="setUnitSystem(state.unitSystem === 'imperial' ? 'metric' : 'imperial')">
        ${state.unitSystem === 'imperial' ? 'Imperial' : 'Metric'}
      </button>
    </div>`;
}

function renderRecipeIngredientPanel(sauce) {
  const aggregated = aggregateSauceIngredients(sauce);
  if (!aggregated.length) return '';
  const items = prepareItems(aggregated);
  const isOpen = !!state.recipeIngredientsOpen;
  const rows = items.map(item => {
    const isQualitative = QUALITATIVE_UNITS.has(item.unit);
    const amountHTML = isQualitative
      ? `<span class="recipe-ingredient-amount recipe-ingredient-amount--qualitative">${item.unit}</span>`
      : `<span class="recipe-ingredient-amount">${formatAmount(item.amount)} ${item.unit}</span>`;
    const displayName = item.modifier ? `${item.modifier} ${item.name}` : item.name;
    return `<li class="recipe-ingredient-item">
      <span class="recipe-ingredient-name">${escapeHtml(displayName)}</span>
      ${amountHTML}
    </li>`;
  }).join('');
  return `
    <div class="card-panel" style="margin-bottom:16px">
      <button class="card-panel__header" onclick="toggleRecipeIngredients()" aria-expanded="${isOpen}">
        <span class="card-panel__header-text"><i data-lucide="list"></i> Ingredients<span class="card-panel__count">${items.length}</span></span>
        <span class="card-panel__chevron ${isOpen ? 'open' : ''}"><i data-lucide="chevron-down"></i></span>
      </button>
      <div class="card-panel__body ${isOpen ? 'open' : ''}">
        <ul class="recipe-ingredient-list">${rows}</ul>
      </div>
    </div>`;
}

function toggleRecipeIngredients() {
  state.recipeIngredientsOpen = !state.recipeIngredientsOpen;
  render();
}

function renderRecipeStep(step, index, allSteps) {
  const stepTime = step.estimatedTime || 5;
  const displayItems = prepareItems(step.ingredients);

  const refs = Array.isArray(step.inputFromSteps) ? step.inputFromSteps : (step.inputFromStep ? [step.inputFromStep] : []);
  for (const ref of refs) {
    const refStep = allSteps[ref - 1];
    if (refStep) {
      const refTsp = cumulativeStepTsp(allSteps, ref - 1, state.servings, state.selectedSauce?.defaultServings || 2);
      const disp = tspToDisplay(refTsp);
      const refName = `Step ${ref} combined`;
      displayItems.unshift({ name: refName, amount: disp.amount, unit: disp.unit });
      // Default previous-step sections to hidden so they don't dwarf new ingredients
      if (!state.hiddenPieSlices[index]) state.hiddenPieSlices[index] = new Set();
      if (!state.hiddenPieSlices[index]._defaulted) {
        state.hiddenPieSlices[index].add(refName);
        state.hiddenPieSlices[index]._defaulted = true;
      }
    }
  }

  return `<div class="step-card" style="--i:${index}" data-shade="${index % 4}">
    <div class="step-header-row">
      <div class="step-number">Step ${index + 1}</div>
      <div class="step-time">~${stepTime}m</div>
    </div>
    <div class="step-title-row">
      <div class="step-title">${step.title}</div>
      ${step.instructions ? `<button class="step-instr-btn" onclick="this.closest('.step-card').querySelector('.step-instructions-body').toggleAttribute('hidden'); this.classList.toggle('expanded')" title="Toggle instructions"><i data-lucide="notebook-pen"></i></button>` : ''}
    </div>
    ${step.instructions ? `<p class="step-instructions-body" hidden>${escapeHtml(step.instructions)}</p>` : ''}
    <div class="step-viz">
      ${buildPieChart(displayItems, 80, index)}
      <div class="step-legend">${buildLegend(displayItems, index)}</div>
    </div>
  </div>`;
}

function renderVariantSwitcher(currentSauceId) {
  const family = state.selectedSauceFamily || [];
  if (family.length <= 1) return '';
  return `
    <div class="variant-switcher" role="tablist" aria-label="Switch variant">
      ${family.map(s => `
        <button class="variant-chip ${s.id === currentSauceId ? 'variant-chip--active' : ''}"
                role="tab"
                aria-selected="${s.id === currentSauceId}"
                onclick="selectVariant('${s.id}')">
          ${escapeHtml(s.name)}${!s.parentSauceId ? '<span class="variant-chip-tag">original</span>' : ''}
        </button>
      `).join('')}
    </div>`;
}

function renderItemPrepBlock(item, prep, sauce) {
  if (!item) return '';
  const itemPrepLabel = item.category === 'salad'
    ? `🥗 Toss ${item.name}`
    : `${item.emoji} ${item.category === 'protein' ? 'Cook' : 'Prep'} ${item.name}${prep ? ` — ${prep.name}` : ''}`;
  const itemColor = item.category === 'protein' ? '#C94E02'
                 : item.category === 'salad'   ? '#2D6A4F'
                 : '#1565C0';
  const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
  const itemInstructions = prep?.instructions
                        || item.instructions
                        || (item.category === 'salad'
                            ? `Toss ${item.name} with ${sauce.name} right before serving`
                            : `Cook ${item.name} per packet instructions`);
  return `
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
}
