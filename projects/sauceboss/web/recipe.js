'use strict';

// Standalone single-sauce recipe view used by Browse, Cookbook (Saucebook), and
// the admin Sauce Manager preview. The meal-builder flow uses the same shared
// renderers (renderRecipeControls, renderRecipeStep, renderVariantSwitcher) via
// meal.js → renderMealRecipe; the only meal-only addition is the dish prep
// block that sits above the first sauce step.
function renderRecipe() {
  const sauce = state.selectedSauce;
  const item  = state.selectedItem;            // null when coming from sauce manager / browse / cookbook

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
    <div class="recipe-header">
      <button class="back-btn" onclick="${isTabShellBack ? `setActiveTab('${state.activeTab}')` : `navigate('${backScreen}')`}"><i data-lucide="chevron-left"></i> Back</button>
      <div class="recipe-cuisine-badge">${renderEmoji(sauce.cuisineEmoji)} ${sauce.cuisine}</div>
      <div class="recipe-title">${sauce.name}</div>
      <div class="recipe-subtitle">Pair with: ${(sauce.attachments || []).filter(a => a.kind === 'dish').map(a => a.value).join(', ')} &nbsp;·&nbsp; ${sauce.steps.length} step${sauce.steps.length > 1 ? 's' : ''}</div>
      ${exportButtonsHTML}
      ${removeBtnHTML ? `<div class="recipe-export-row">${removeBtnHTML}</div>` : ''}
    </div>
    <div class="scroll-body scroll-body--padded">
      ${renderVariantSwitcher(sauce.id)}
      ${renderRecipeControls()}
      ${renderRecipeIngredientPanel(sauce)}
      ${subBannerHTML}
      <div class="steps-container">
        ${sauce.steps.map((step, i) => renderRecipeStep(step, i, sauce.steps)).join('')}
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
