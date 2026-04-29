'use strict';

function renderRecipe() {
  const sauce = state.selectedSauce;
  const carb = state.selectedCarb;  // may be null when coming from sauce manager
  const carbTotal = carb ? (carb.portionPerPerson || 100) * state.servings : null;
  const carbUnit = carb ? (carb.portionUnit || 'g') : '';

  // Substitution banner for disabled ingredients
  const disabledInRecipe = sauce.ingredients
    .filter(i => state.disabledIngredients.has(i.name))
    .map(i => ({ name: i.name, sub: getSubstitutionText(i.name) }))
    .filter(i => i.sub);
  const subBannerHTML = disabledInRecipe.length > 0 ? `
    <div class="sub-banner">
      <strong>Ingredient swaps</strong>
      ${disabledInRecipe.map(i => `<div>${i.name} → <strong>${i.sub}</strong></div>`).join('')}
    </div>` : '';

  // Time calculations
  const sauceStepTimes = sauce.steps.map((st, i) =>
    st.estimatedTime || (SAUCE_TIMES[sauce.id] && SAUCE_TIMES[sauce.id][i]) || 5
  );
  const sauceTime = sauceStepTimes.reduce((s, t) => s + t, 0);
  const carbTime = carb
    ? ((state.selectedPrep?.cookTimeMinutes ?? carb.cookTimeMinutes) ?? CARB_COOK_TIMES[carb.id]?.minutes ?? 0)
    : 0;
  const backScreen = carb ? 'sauce-selector' : 'admin';
  const addons = [];
  const addonTime = 0;
  const totalTime = sauceTime + carbTime + addonTime;

  const stepsHTML = sauce.steps.map((step, i) => {
    const stepTime = sauceStepTimes[i] || 5;
    const displayItems = prepareItems(step.ingredients);

    // Fix: if this step combines output from a previous step, compute tsp-equivalent
    // correctly (summing across all units) for accurate pie chart proportions
    const refStep = step.inputFromStep ? sauce.steps[step.inputFromStep - 1] : null;
    if (refStep) {
      const refTspTotal = refStep.ingredients.reduce((s, it) =>
        s + toTsp(scaleAmount(it.amount, state.servings), it.unit), 0
      );
      let dispAmt = refTspTotal, dispUnit = 'tsp';
      if (refTspTotal >= 48) { dispAmt = +(refTspTotal / 48).toFixed(1); dispUnit = 'cup'; }
      else if (refTspTotal >= 3) { dispAmt = +(refTspTotal / 3).toFixed(1); dispUnit = 'tbsp'; }
      displayItems.unshift({ name: `Step ${step.inputFromStep} combined`, amount: dispAmt, unit: dispUnit });
    }

    const refBadge = refStep
      ? `<div class="step-ref-badge"><i data-lucide="corner-down-right"></i> Combine all of Step ${step.inputFromStep} into this bowl</div>`
      : '';

    return `<div class="step-card" style="--i:${i}">
      <div class="step-header-row">
        <div class="step-number">Step ${i + 1}</div>
        <div class="step-time">~${stepTime}m</div>
      </div>
      <div class="step-title">${step.title}</div>
      ${refBadge}
      <div class="pie-container">
        ${buildPieChart(displayItems, 170)}
        <div class="legend">${buildLegend(displayItems)}</div>
      </div>
    </div>`;
  }).join('');

  const addonCardsHTML = addons.map(addon => `
    <div class="addon-card ${addon.type === 'protein' ? 'addon-protein' : 'addon-veggie'}">
      <div class="addon-card-header">
        <span class="addon-card-emoji">${addon.emoji}</span>
        <div>
          <div class="addon-card-title">${addon.name}</div>
          <div class="addon-card-meta">~${addon.estimatedTime} min</div>
        </div>
      </div>
      <p class="addon-card-instructions">${addon.instructions}</p>
    </div>`).join('');

  const addonTimeBadgesHTML = addons.map(addon =>
    `<span class="time-badge">${addon.emoji} ~${addon.estimatedTime}m</span>`
  ).join('');

  return `
    <div class="status-bar"></div>
    <div class="recipe-header">
      <button class="back-btn" onclick="navigate('${backScreen}')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="recipe-cuisine-badge">${renderEmoji(sauce.cuisineEmoji)} ${sauce.cuisine}</div>
      <div class="recipe-title">${sauce.name}</div>
      <div class="recipe-subtitle">Pair with: ${sauce.compatibleCarbs.join(', ')} &nbsp;·&nbsp; ${sauce.steps.length} step${sauce.steps.length > 1 ? 's' : ''}</div>
    </div>
    <div class="recipe-controls">
      <div class="serving-row">
        <div class="serving-info">
          ${carb ? `<span class="serving-carb">${formatAmount(carbTotal)}${carbUnit} ${carb.name.toLowerCase()}</span>
          <span class="serving-for">for</span>` : ''}
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
      <div class="time-summary">
        ${carbTime > 0 ? `<span class="time-badge">${carb.emoji} ~${carbTime}m</span>` : ''}
        <span class="time-badge">🧂 Sauce ~${sauceTime}m</span>
        ${addonTimeBadgesHTML}
        <span class="time-total">Total ~${totalTime}m</span>
      </div>
    </div>
    <div class="scroll-body" style="padding:0">
      ${subBannerHTML}
      ${state.selectedPrep ? `
      <div class="prep-card">
        <div class="prep-card-header">
          <span class="prep-card-emoji">${state.selectedPrep.emoji || (carb ? carb.emoji : '')}</span>
          <div>
            <div class="prep-card-title">${state.selectedPrep.name}</div>
            <div class="prep-card-meta">${state.selectedPrep.cookTime || ''}${state.selectedPrep.waterRatio ? ' · ' + state.selectedPrep.waterRatio : ''}</div>
          </div>
        </div>
        <p class="prep-card-instructions">${state.selectedPrep.instructions || ''}</p>
      </div>` : ''}
      ${addonCardsHTML}
      <div class="steps-container">
        ${stepsHTML}
      </div>
      <div class="tip-card">
        <strong><i data-lucide="lightbulb"></i> How to read the chart</strong>
        Each slice shows the relative proportion of that ingredient. Bigger slice = more of it. Adjust the people count above to scale the recipe.
      </div>
    </div>
  `;
}

function setServings(n) {
  state.servings = Math.max(1, Math.min(12, n));
  render();
}

function setUnitSystem(sys) {
  state.unitSystem = sys;
  render();
}
