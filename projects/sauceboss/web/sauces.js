'use strict';

// Header context derived from the currently selected item's category.
function getSauceScreenContext() {
  const item = state.selectedItem;
  const meta = flowMetaFor(item);
  return {
    sauces:      state.saucesForCurrentItem,
    backScreen:  state.preparations.length > 0 ? 'prep-selector' : 'meal-builder',
    emoji:       item ? item.emoji : '🍲',
    title:       item ? `${item.name} ${meta.sauceTypeLabel.charAt(0).toUpperCase() + meta.sauceTypeLabel.slice(1)}` : 'Sauces',
  };
}

function renderSauceSelector() {
  const ctx = getSauceScreenContext();
  const allSauces = ctx.sauces;
  const sauces = state.favoritesOnly && currentUser
    ? allSauces.filter(s => state.favorites.has(s.id))
    : allSauces;
  const cuisines = [...new Set(sauces.map(s => s.cuisine))];
  const missingCount = state.disabledIngredients.size;
  const categoryGroups = groupIngredientsByCategory();
  const favCount = currentUser
    ? allSauces.filter(s => state.favorites.has(s.id)).length
    : 0;

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
    const safeCuisine = cuisine.replace(/'/g, "\\'");

    const saucesHTML = isOpen ? cuisineSauces.map(sauce => {
      const available = isSauceAvailable(sauce);
      const missing = missingSauceIngredients(sauce);
      const missingText = missing.map(m => {
        const sub = getSubstitutionText(m);
        return sub ? `${m} (try ${sub})` : m;
      }).join(', ');
      const compatText = (sauce.compatibleItems || []).join(' · ');
      const isFav = currentUser && state.favorites.has(sauce.id);
      const canEdit = currentUser && (currentUser.is_admin || sauce.createdBy === currentUser.user_id);
      const heartBtn = currentUser
        ? `<button class="heart-btn ${isFav ? 'heart-btn--active' : ''}" data-auth-only
                   onclick="event.stopPropagation(); toggleFavorite('${sauce.id}')"
                   aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
             <i data-lucide="${isFav ? 'heart' : 'heart'}"></i>
           </button>`
        : '';
      const editBtn = canEdit
        ? `<button class="sauce-edit-btn"
                   onclick="event.stopPropagation(); openBuilderEdit('${sauce.id}')"
                   aria-label="Edit sauce">
             <i data-lucide="pencil"></i>
           </button>`
        : '';
      return `<div class="sauce-item ${available ? '' : 'unavailable'}" onclick="selectSauce('${sauce.id}')">
        <span class="sauce-dot" style="background:${sauce.color}"></span>
        <div class="sauce-info">
          <div class="sauce-item-name">${sauce.name}</div>
          <div class="sauce-item-tags">${compatText}${missing.length ? ' · missing: '+missingText : ''}</div>
        </div>
        ${!available ? `<span class="sauce-missing-badge">-${missing.length}</span>` : ''}
        ${heartBtn}
        ${editBtn}
        <span class="sauce-arrow"><i data-lucide="chevron-right"></i></span>
      </div>`;
    }).join('') : '';

    return `<div class="ingredient-category-group" id="cg-${cuisine}">
      <div class="ingredient-category-header" onclick="toggleCuisine('${safeCuisine}')">
        <span class="ingredient-category-chevron">${isOpen ? '▾' : '▸'}</span>
        <span class="cuisine-flag-emoji">${emoji}</span>
        <span class="ingredient-category-name">${cuisine}</span>
        <span class="ingredient-category-count">${availCount}/${cuisineSauces.length}</span>
      </div>
      ${isOpen ? `<div class="ingredient-category-body">${saucesHTML}</div>` : ''}
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
      ${currentUser ? `
        <div class="favorites-pill-row" data-auth-only>
          <button class="favorites-pill ${state.favoritesOnly ? 'favorites-pill--active' : ''}"
                  onclick="toggleFavoritesOnly()"
                  ${favCount === 0 && !state.favoritesOnly ? 'disabled' : ''}>
            <i data-lucide="heart"></i>
            ${state.favoritesOnly ? 'Favorites only' : 'Show favorites only'}
            <span class="favorites-pill-count">${favCount}</span>
          </button>
        </div>
      ` : ''}
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

function selectSauce(id) {
  state.selectedSauce = state.saucesForCurrentItem.find(s => s.id === id);
  state.meal.item  = state.selectedItem;
  state.meal.prep  = state.selectedPrep;
  state.meal.sauce = state.selectedSauce;
  navigate('meal-recipe');
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

function toggleFavoritesOnly() {
  if (!currentUser) { openAuthModal(); return; }
  state.favoritesOnly = !state.favoritesOnly;
  render();
}
