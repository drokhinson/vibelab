'use strict';

// Unified recipe view — handles both standalone (Browse / Saucebook / Sauce
// Manager) and meal-builder flows. When state.meal has item + sauce, the dish
// prep block is shown after the ingredient section. Otherwise it's sauce-only.
function renderRecipe() {
  const sauce = state.selectedSauce;

  // Meal-builder context: if the user arrived via the meal flow, state.meal
  // has all three pieces. If they came from Browse / Saucebook / Sauce
  // Manager, selectedItem is null and meal.sauce is absent.
  const isMeal = !!(state.meal && state.meal.item && state.meal.sauce);
  const item = isMeal ? state.meal.item : null;
  const prep = isMeal ? state.meal.prep : null;

  // Substitution banner for disabled ingredients
  const disabledInRecipe = sauce.ingredients
    .filter(i => state.disabledIngredients.has(i.name))
    .map(i => ({ name: i.name, sub: getSubstitutionText(i.name) }))
    .filter(i => i.sub);
  const subBannerHTML = disabledInRecipe.length > 0 ? `
    <div class="sub-banner">
      <strong>Ingredient swaps</strong>
      ${disabledInRecipe.map(i => `<div>${capitalizeIngredient(i.name)} → <strong>${capitalizeIngredient(i.sub)}</strong></div>`).join('')}
    </div>` : '';

  // Back-button target
  const backOnClick = isMeal
    ? "navigate('meal-category')"
    : (state.recipeReturnTo === 'tab-shell'
        ? `setActiveTab('${state.activeTab}')`
        : `navigate('${state.recipeReturnTo || 'admin'}')`);

  // Saucebook toggle
  const inSaucebook = !!(currentUser && (state.saucebook || []).some(s => s.id === sauce.id));
  const saucebookBtnHTML = inSaucebook
    ? `<button class="recipe-action-btn recipe-action-btn--active" onclick="recipeToggleSaucebook('${sauce.id}')" title="Remove from saucebook"><i data-lucide="bookmark-check"></i></button>`
    : `<button class="recipe-action-btn" onclick="recipeToggleSaucebook('${sauce.id}')" title="Save to saucebook"><i data-lucide="bookmark-plus"></i></button>`;

  // Download button
  const downloadBtnHTML = `<a class="recipe-action-btn" href="${API}/api/v1/sauceboss/sauces/${encodeURIComponent(sauce.id)}/export.md" download title="Download recipe"><i data-lucide="download"></i></a>`;

  // Always use colored-tag meal-section style for sauce steps
  const isMarinade = sauce.sauceType === 'marinade';
  const sauceColor = isMarinade ? '#5D4037'
                   : sauce.sauceType === 'dressing' ? '#1B5E20'
                   : '#4A0072';
  const sauceLabel = isMeal
    ? `${flowMetaFor(item).sauceWord} — ${sauce.name}`
    : `Sauce — ${sauce.name}`;
  const sauceSection = `
    <div class="meal-section">
      <div class="meal-section-label" style="background:${sauceColor}">${sauceLabel}</div>
      ${sauce.steps.map((step, i) => renderRecipeStep(step, i, sauce.steps)).join('')}
    </div>`;
  let stepsHTML;
  if (isMeal) {
    const itemBlock = renderItemPrepBlock(item, prep, sauce);
    stepsHTML = isMarinade
      ? sauceSection + itemBlock
      : itemBlock + sauceSection;
  } else {
    stepsHTML = sauceSection;
  }

  return `
    ${renderAppHeader({
      title: sauce.name,
      back: { onClick: backOnClick },
      auth: false,
      manage: 'never',
      extraActions: saucebookBtnHTML + downloadBtnHTML,
    })}
    <div class="scroll-body scroll-body--padded">
      ${renderVariantSwitcher(sauce.id)}
      ${renderRecipeControls()}
      ${renderRecipeIngredientPanel(sauce)}
      ${subBannerHTML}
      ${stepsHTML}
    </div>
  `;
}

// Load a sauce by id and open the recipe view. Used by the boot path when
// the URL is a `/sauce/<id>` permalink, and by popstate when the user
// navigates back/forward into a recipe entry.
function openRecipePermalink(sauceId, opts = {}) {
  const { push = true } = opts;
  state.loading = 'Loading recipe…';
  render();
  api.allSauces().then(all => {
    state.loading = null;
    const found = all.find(s => s.id === sauceId);
    if (!found) {
      // Unknown id — drop the user on the default tab and clear the URL so
      // a stale permalink doesn't trap them on an empty screen.
      state.activeTab = currentUser ? 'saucebook' : 'browse';
      state.screen = 'tab-shell';
      history.replaceState(
        { screen: 'tab-shell', tab: state.activeTab, sb: true },
        '', '#' + state.activeTab,
      );
      render();
      return;
    }
    const rootId = found.parentSauceId || found.id;
    const family = all.filter(s => s.id === rootId || s.parentSauceId === rootId);
    state.selectedSauce = found;
    state.servings = found.defaultServings || 2;
    state.selectedSauceFamily = family.length ? family : [found];
    state.hiddenPieSlices = {};
    state.selectedItem = null;
    state.meal = { item: null, prep: null, sauce: null };
    state.recipeReturnTo = 'tab-shell';
    navigate('recipe', { path: '/sauce/' + encodeURIComponent(found.id), push, replace: !push });
  }).catch(err => {
    state.loading = null;
    console.warn('[sauceboss] recipe permalink load failed:', err);
    state.activeTab = currentUser ? 'saucebook' : 'browse';
    state.screen = 'tab-shell';
    history.replaceState(
      { screen: 'tab-shell', tab: state.activeTab, sb: true },
      '', '#' + state.activeTab,
    );
    render();
  });
}

function setServings(n) {
  state.servings = Math.max(1, Math.min(12, n));
  render();
}

function setUnitSystem(sys) {
  state.unitSystem = sys;
  render();
}

async function recipeToggleSaucebook(sauceId) {
  if (!currentUser) { openAuthModal(); return; }
  const inSaucebook = (state.saucebook || []).some(s => s.id === sauceId);
  if (inSaucebook) {
    try {
      await api.removeFromSaucebook(sauceId);
    } catch (err) {
      alert(`Couldn't remove: ${err.message || err}`);
      return;
    }
    state.saucebook = (state.saucebook || []).filter(s => s.id !== sauceId);
  } else {
    try {
      await api.addToSaucebook(sauceId);
    } catch (err) {
      alert(`Couldn't save: ${err.message || err}`);
      return;
    }
    // Re-fetch saucebook to get the full envelope
  }
  refreshSaucebookAndPantry();
  render();
}
