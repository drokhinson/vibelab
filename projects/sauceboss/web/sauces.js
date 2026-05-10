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
    emoji:       item ? item.emoji : '🍲',
    title:       item ? `${item.name} ${meta.sauceTypeLabel.charAt(0).toUpperCase() + meta.sauceTypeLabel.slice(1)}` : 'Sauces',
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
    <div class="status-bar"></div>
    ${renderAppHeader({
      title: ctx.title,
      subtitle: `${visibleEntries.length} options · select your style`,
      titleEmoji: ctx.emoji,
      back: { onClick: `navigate('${ctx.backScreen}')` },
    })}
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
      ${accordionHTML || '<p class="empty-hint">No sauces match this filter yet.</p>'}
    </div>
  `;
}

// Selecting a family from the list: rebuild the family from current sauces,
// pick the displayed sauce, and stash the full sibling list so the
// recipe-view variant switcher doesn't need another fetch.
function selectSauce(rootId, displayedId) {
  const families = buildSauceFamilies(state.saucesForCurrentItem);
  const family = families.get(rootId);
  if (!family) return;
  const sauce = (displayedId && [family.root, ...family.variants].find(s => s.id === displayedId))
    || _pickDisplayedFromFamily(family);
  state.selectedSauce = sauce;
  state.selectedSauceFamily = [family.root, ...family.variants];
  state.meal.item  = state.selectedItem;
  state.meal.prep  = state.selectedPrep;
  state.meal.sauce = state.selectedSauce;
  navigate('meal-recipe');
}

// Switch between siblings inside the recipe / meal-recipe view.
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

