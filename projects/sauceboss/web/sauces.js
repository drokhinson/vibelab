'use strict';

// Header context derived from the currently selected item's category.
function getSauceScreenContext() {
  const item = state.selectedItem;
  const meta = flowMetaFor(item);
  // The saucebook-driven flow goes meal-category (tabbed dish grid) →
  // meal-subtype (only for dishes that have subtypes) → sauce-selector.
  // Back from the sauce list returns to whichever picker was last shown.
  let backScreen = 'meal-category';
  if (state.mealFlow && state.mealFlow.dish) {
    const subs = state.mealFlow.dish.subtypes || state.mealFlow.dish.variants || [];
    backScreen = subs.length > 0 ? 'meal-subtype' : 'meal-category';
  }
  return {
    sauces:      state.saucesForCurrentItem,
    backScreen,
    sauceWord:   meta.sauceWord.toLowerCase(),
  };
}

// Family grouping is a pure helper in shared/families.js (buildSauceFamilies
// is bridged onto window).
function _pickDisplayedFromFamily(family) {
  return SBShared.families.pickDisplayedFromFamily(family);
}

function renderSauceSelector() {
  const ctx = getSauceScreenContext();
  const allSauces = ctx.sauces;
  const families = buildSauceFamilies(allSauces);

  // Each family contributes its root to the rendered list; variants are
  // reachable via the recipe-view variant switcher.
  const visibleEntries = [...families.values()].map(family => ({
    family,
    displayed: _pickDisplayedFromFamily(family),
  }));

  const cuisines = [...new Set(visibleEntries.map(e => e.displayed.cuisine))];
  // Count only the missing ingredients that are actually shown in this
  // sauce list — `state.disabledIngredients` covers the user's full pantry
  // across every dish, but the chip list (and the badge) is scoped to
  // ingredients used by the currently displayed sauces.
  const missingCount = state.allIngredients.filter(name => state.disabledIngredients.has(name)).length;
  const categoryGroups = groupIngredientsByCategory();

  const chipHTML = (items) => items.map(({ name }) => {
    const has = !state.disabledIngredients.has(name);
    return `<button class="chip ${has ? 'has' : 'missing'}" data-ingredient="${name.replace(/"/g, '&quot;')}">
      <i data-lucide="${has ? 'check' : 'x'}"></i> ${name}
    </button>`;
  }).join('');

  const filterBody = `
    <div class="card-panel__body ${state.filterOpen ? 'open' : ''}">
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
    const cuisineEntries = visibleEntries.filter(e => e.displayed.cuisine === cuisine);
    const emoji = renderEmoji(cuisineEntries[0]?.displayed.cuisineEmoji || '🍽️');
    const isOpen = state.expandedCuisines.has(cuisine);
    const availCount = cuisineEntries.filter(e => isSauceAvailable(e.displayed)).length;
    const safeCuisine = cuisine.replace(/'/g, "\\'");

    const saucesHTML = isOpen ? cuisineEntries.map(({ family, displayed }) => {
      const sauce = displayed;
      const totalVersions = 1 + family.variants.length;
      const available = isSauceAvailable(sauce);
      const missing = missingSauceIngredients(sauce);
      const variantBadge = totalVersions >= 2
        ? `<span class="variant-badge" title="${totalVersions} versions in this family"><i data-lucide="git-branch"></i> ${totalVersions}</span>`
        : '';
      const rightSlot = !available
        ? `<span class="sauce-missing-badge" title="${missing.length} ingredient${missing.length === 1 ? '' : 's'} missing">-${missing.length}</span>`
        : '';
      // No edit affordance — the sauce-selector is part of the cooking
      // workflow, not authoring. Editing lives in saucebook swipe and the
      // Sauce Manager.
      return renderSauceRow(sauce, {
        rowClass: available ? '' : 'unavailable',
        onClick: `selectSauce('${family.root.id}','${sauce.id}')`,
        variantBadge,
        rightSlot,
      });
    }).join('') : '';

    return renderCuisineGroup({
      label: cuisine,
      emoji,
      count: `${availCount}/${cuisineEntries.length}`,
      isOpen,
      onToggle: `toggleCuisine('${safeCuisine}')`,
      body: saucesHTML,
    });
  }).join('');

  return `
    ${renderAppHeader({
      title: 'Meal Builder',
      subtitle: `Pick your ${ctx.sauceWord}`,
      back: { onClick: `navigate('${ctx.backScreen}')` },
      auth: false,
    })}
    <div class="scroll-body">
      <div class="card-panel" style="margin:16px">
        <button class="card-panel__header" onclick="toggleFilter()">
          <span class="card-panel__header-text"><i data-lucide="shopping-basket"></i> My Pantry${missingCount > 0 ? `<span class="card-panel__count">−${missingCount} missing</span>` : ''}</span>
          <span class="card-panel__chevron ${state.filterOpen ? 'open' : ''}"><i data-lucide="chevron-down"></i></span>
        </button>
        ${filterBody}
      </div>
      <p class="section-label">Pick a recipe</p>
      ${accordionHTML || '<p class="empty-hint">No sauces match this filter yet.</p>'}
    </div>
  `;
}

// Selecting a family from the list: rebuild the family from current sauces,
// pick the displayed sauce, and stash the full sibling list so the
// recipe-view variant switcher doesn't need another fetch.
//
// Saucebook envelopes are slim — they carry `ingredientNames` but no
// `steps[].ingredients[]`. The recipe view iterates `sauce.steps` and
// crashes on undefined, so we hydrate the full sauce + its family via
// /sauces (same pattern as browseOpenRecipe / saucebookOpenRecipe) before
// navigating.
function selectSauce(rootId, displayedId) {
  const families = buildSauceFamilies(state.saucesForCurrentItem);
  const family = families.get(rootId);
  if (!family) return;
  const slim = (displayedId && [family.root, ...family.variants].find(s => s.id === displayedId))
    || _pickDisplayedFromFamily(family);
  if (!slim) return;
  state.loading = 'Loading recipe…';
  render();
  api.allSauces().then(all => {
    state.loading = null;
    const found = all.find(s => s.id === slim.id);
    if (!found) { render(); return; }
    const familyId = found.parentSauceId || found.id;
    const fullFamily = all.filter(s => s.id === familyId || s.parentSauceId === familyId);
    state.selectedSauce = found;
    state.selectedSauceFamily = fullFamily.length ? fullFamily : [found];
    state.meal.item  = state.selectedItem;
    state.meal.prep  = state.selectedPrep;
    state.meal.sauce = found;
    navigate('recipe');
  }).catch(err => {
    state.loading = null;
    console.warn('[sauceboss] sauce hydrate failed:', err);
    render();
  });
}

// Switch between siblings inside the recipe view.
function selectVariant(id) {
  const next = (state.selectedSauceFamily || []).find(s => s.id === id);
  if (!next) return;
  state.selectedSauce = next;
  if (state.meal && state.meal.sauce) state.meal.sauce = next;
  render();
}

function toggleFilter() {
  state.filterOpen = !state.filterOpen;
  render();
}

function toggleIngredient(name) {
  // Anon users: session-only toggle (pantry persistence requires auth).
  if (!currentUser) {
    if (state.disabledIngredients.has(name)) state.disabledIngredients.delete(name);
    else state.disabledIngredients.add(name);
    render();
    return;
  }
  // Logged-in: route through the pantry. Find the ingredientId for this name in
  // either the saucebook ingredient surface (most authoritative) or the
  // current sauce list (fallback for sauces not yet in saucebook).
  let ingredientId = null;
  for (const ing of state.pantry.ingredients || []) {
    if (ing.name === name) { ingredientId = ing.ingredientId; break; }
  }
  if (!ingredientId) {
    for (const s of state.saucesForCurrentItem || []) {
      for (const ing of s.ingredients || []) {
        if (ing.name === name && ing.ingredientId) { ingredientId = ing.ingredientId; break; }
      }
      if (ingredientId) break;
    }
  }
  if (ingredientId) {
    togglePantryMissing(ingredientId);
  } else {
    // Unknown ingredient (no ingredientId resolution) — degrade to session-only
    // toggle so the chip still feels responsive.
    if (state.disabledIngredients.has(name)) state.disabledIngredients.delete(name);
    else state.disabledIngredients.add(name);
    render();
  }
}

function toggleCuisine(name) {
  if (state.expandedCuisines.has(name)) state.expandedCuisines.delete(name);
  else state.expandedCuisines.add(name);
  render();
}

