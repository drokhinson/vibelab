'use strict';

// Standalone single-sauce recipe view (e.g. when previewing a sauce from the
// admin Sauce Manager). For the full meal flow with paired item prep, see
// meal.js → renderMealRecipe.
function renderRecipe() {
  const sauce = state.selectedSauce;
  const item  = state.selectedItem;            // may be null when coming from sauce manager
  const itemTotal = item ? (item.portionPerPerson || 100) * state.servings : null;
  const itemUnit  = item ? (item.portionUnit || 'g') : '';

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
  const sauceStepTimes = sauce.steps.map(st => st.estimatedTime || 5);
  const sauceTime = sauceStepTimes.reduce((s, t) => s + t, 0);
  const itemTime  = item
    ? ((state.selectedPrep?.cookTimeMinutes ?? item.cookTimeMinutes) ?? 0)
    : 0;
  // backScreen priority: meal flow > explicit override (saucebook/browse) > admin.
  const backScreen = item
    ? 'sauce-selector'
    : (state.recipeReturnTo || 'admin');
  const isTabShellBack = backScreen === 'tab-shell';

  // Show a "Remove from saucebook" affordance when the user is viewing one
  // of their saucebook entries from the tab UI. Anonymous users + admin
  // sauce-manager previews don't see this button.
  const inSaucebook = !!(currentUser && (state.saucebook || []).some(s => s.id === sauce.id));
  const removeBtnHTML = (currentUser && isTabShellBack && inSaucebook)
    ? `<button class="recipe-export-btn"
               onclick="recipeRemoveFromSaucebook('${sauce.id}')"
               title="Remove from your saucebook">
         <i data-lucide="bookmark-minus"></i> Remove from saucebook
       </button>`
    : '';
  const totalTime  = sauceTime + itemTime;

  const stepsHTML = sauce.steps.map((step, i) => {
    const stepTime = sauceStepTimes[i] || 5;
    const displayItems = prepareItems(step.ingredients);

    const refStep = step.inputFromStep ? sauce.steps[step.inputFromStep - 1] : null;
    if (refStep) {
      const refTspTotal = cumulativeStepTsp(sauce.steps, step.inputFromStep - 1, state.servings);
      const disp = tspToDisplay(refTspTotal);
      displayItems.unshift({ name: `Step ${step.inputFromStep} combined`, amount: disp.amount, unit: disp.unit });
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
      ${step.instructions ? `
        <details class="step-instructions-toggle">
          <summary>Instructions</summary>
          <p class="step-instructions-body">${escapeHtml(step.instructions)}</p>
        </details>` : ''}
      ${refBadge}
      <div class="pie-container">
        ${buildPieChart(displayItems, 170)}
        <div class="legend">${buildLegend(displayItems)}</div>
      </div>
    </div>`;
  }).join('');

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

  // Export buttons live alongside the other edit affordances — gated on edit
  // mode (logged-in users only). Anonymous visitors can still hit the public
  // export URLs directly via shared links.
  const exportButtonsHTML = (currentUser && state.editMode) ? `
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
    </div>` : '';

  return `
    <div class="status-bar"></div>
    <div class="recipe-header">
      <button class="back-btn" onclick="${isTabShellBack ? `setActiveTab('${state.activeTab}')` : `navigate('${backScreen}')`}"><i data-lucide="chevron-left"></i> Back</button>
      <div class="recipe-cuisine-badge">${renderEmoji(sauce.cuisineEmoji)} ${sauce.cuisine}</div>
      <div class="recipe-title">${sauce.name}</div>
      <div class="recipe-subtitle">Pair with: ${(sauce.compatibleItems || []).join(', ')} &nbsp;·&nbsp; ${sauce.steps.length} step${sauce.steps.length > 1 ? 's' : ''}</div>
      ${variantSwitcherHTML}
      ${exportButtonsHTML}
      ${removeBtnHTML ? `<div class="recipe-export-row">${removeBtnHTML}</div>` : ''}
    </div>
    <div class="recipe-controls">
      <div class="serving-row">
        <div class="serving-info">
          ${item ? `<span class="serving-carb">${formatAmount(itemTotal)}${itemUnit} ${item.name.toLowerCase()}</span>
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
        ${itemTime > 0 ? `<span class="time-badge">${item.emoji} ~${itemTime}m</span>` : ''}
        <span class="time-badge">🧂 Sauce ~${sauceTime}m</span>
        <span class="time-total">Total ~${totalTime}m</span>
      </div>
    </div>
    <div class="scroll-body" style="padding:0">
      ${subBannerHTML}
      ${state.selectedPrep ? `
      <div class="prep-card">
        <div class="prep-card-header">
          <span class="prep-card-emoji">${state.selectedPrep.emoji || (item ? item.emoji : '')}</span>
          <div>
            <div class="prep-card-title">${state.selectedPrep.name}</div>
            <div class="prep-card-meta">${state.selectedPrep.cookTimeMinutes ? state.selectedPrep.cookTimeMinutes + ' min' : ''}${state.selectedPrep.waterRatio ? ' · ' + state.selectedPrep.waterRatio : ''}</div>
          </div>
        </div>
        <p class="prep-card-instructions">${state.selectedPrep.instructions || ''}</p>
      </div>` : ''}
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

async function recipeRemoveFromSaucebook(sauceId) {
  if (!currentUser) return;
  if (!confirm('Remove this recipe from your saucebook?')) return;
  try {
    await api.removeFromSaucebook(sauceId);
  } catch (err) {
    alert(`Couldn't remove: ${err.message || err}`);
    return;
  }
  // Drop locally + refresh saucebook + pantry; navigate back to whichever
  // tab the user came from (saucebook or browse).
  state.saucebook = (state.saucebook || []).filter(s => s.id !== sauceId);
  refreshSaucebookAndPantry();
  setActiveTab(state.activeTab || 'saucebook');
}
