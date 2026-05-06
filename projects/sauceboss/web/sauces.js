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

// Group a flat list of sauces into families: { root, variants[] } keyed by
// root id. A sauce with parentSauceId is attached as a variant to its
// parent; orphans (parent not in this list) render as their own root so
// they don't disappear from the list.
function _buildSauceFamilies(sauces) {
  const byId = new Map();
  for (const s of sauces) byId.set(s.id, s);

  const families = new Map();
  // First pass: every sauce without a present parent becomes a root.
  for (const s of sauces) {
    if (!s.parentSauceId || !byId.has(s.parentSauceId)) {
      if (!families.has(s.id)) families.set(s.id, { root: s, variants: [] });
    }
  }
  // Second pass: attach variants to their root.
  for (const s of sauces) {
    if (s.parentSauceId && byId.has(s.parentSauceId)) {
      const fam = families.get(s.parentSauceId);
      if (fam) fam.variants.push(s);
    }
  }
  return families;
}

// Pick which sauce in a family to show in the list / open in the recipe by
// default. Rule: if the user has favorited any sibling, pick the one with
// the most recent favorite timestamp; otherwise show the root.
function _pickDisplayedFromFamily(family) {
  const all = [family.root, ...family.variants];
  if (!currentUser) return family.root;
  let best = null;
  let bestTime = -Infinity;
  for (const s of all) {
    if (!state.favorites.has(s.id)) continue;
    const ts = state.favorites.get(s.id);
    const t = ts ? Date.parse(ts) : 0;
    if (t > bestTime) { bestTime = t; best = s; }
  }
  return best || family.root;
}

function _familyHasFavorite(family) {
  if (!currentUser) return false;
  if (state.favorites.has(family.root.id)) return true;
  return family.variants.some(v => state.favorites.has(v.id));
}

function renderSauceSelector() {
  const ctx = getSauceScreenContext();
  const allSauces = ctx.sauces;
  const families = _buildSauceFamilies(allSauces);

  // Family-level filtering — favorites pill toggles whether unfavored
  // families are hidden.
  const allFamilies = [...families.values()];
  const visibleFamilies = state.favoritesOnly && currentUser
    ? allFamilies.filter(_familyHasFavorite)
    : allFamilies;
  const favFamilyCount = currentUser
    ? allFamilies.filter(_familyHasFavorite).length
    : 0;

  // Each visible family contributes its displayed sauce to the rendered list.
  const visibleEntries = visibleFamilies.map(family => ({
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
      const missingText = missing.map(m => {
        const sub = getSubstitutionText(m);
        return sub ? `${m} (try ${sub})` : m;
      }).join(', ');
      const compatText = (sauce.compatibleItems || []).join(' · ');
      const isFav = currentUser && state.favorites.has(sauce.id);
      const canEdit = currentUser && (currentUser.is_admin || sauce.createdBy === currentUser.user_id);
      const variantBadge = totalVersions >= 2
        ? `<span class="variant-badge" title="${totalVersions} versions in this family"><i data-lucide="git-branch"></i> ${totalVersions}</span>`
        : '';
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
      return `<div class="sauce-item ${available ? '' : 'unavailable'}" onclick="selectSauce('${family.root.id}','${sauce.id}')">
        <span class="sauce-dot" style="background:${sauce.color}"></span>
        <div class="sauce-info">
          <div class="sauce-item-name">${sauce.name}${variantBadge}</div>
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
        <span class="ingredient-category-count">${availCount}/${cuisineEntries.length}</span>
      </div>
      ${isOpen ? `<div class="ingredient-category-body">${saucesHTML}</div>` : ''}
    </div>`;
  }).join('');

  return `
    <div class="status-bar"></div>
    <div class="app-header">
      <button class="back-btn" onclick="navigate('${ctx.backScreen}')"><i data-lucide="chevron-left"></i> Back</button>
      <div class="logo"><span>${ctx.emoji}</span>${ctx.title}</div>
      <div class="subtitle">${visibleEntries.length} options · select your style</div>
      ${renderHeaderAuthSlot()}
    </div>
    <div class="scroll-body">
      ${currentUser ? `
        <div class="favorites-pill-row" data-auth-only>
          <button class="favorites-pill ${state.favoritesOnly ? 'favorites-pill--active' : ''}"
                  onclick="toggleFavoritesOnly()"
                  ${favFamilyCount === 0 && !state.favoritesOnly ? 'disabled' : ''}>
            <i data-lucide="heart"></i>
            ${state.favoritesOnly ? 'Favorites only' : 'Show favorites only'}
            <span class="favorites-pill-count">${favFamilyCount}</span>
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

// Selecting a family from the list: rebuild the family from current sauces,
// pick the displayed sauce, and stash the full sibling list so the
// recipe-view variant switcher doesn't need another fetch.
function selectSauce(rootId, displayedId) {
  const families = _buildSauceFamilies(state.saucesForCurrentItem);
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
