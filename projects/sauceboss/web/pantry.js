'use strict';
// @ts-check
//
// Pantry tab — negative ingredient list. Surfaces every food appearing in
// the user's saucebook recipes; tapping a row toggles its missing flag and
// persists to /pantry. The same backing store is read by the meal-builder's
// ingredient filter, so changes here update which sauces show as
// missing-X-and-Y over there (and vice versa).
//
// Group ingredients by `state.ingredientCategories` (Produce, Dairy, Spices,
// etc.) so the list is scannable; rows in `Uncategorized` collect anything
// without a classification.

function renderPantry() {
  const ings = state.pantry.ingredients || [];
  if (ings.length === 0) {
    return `
      <div class="screen-wrap">
        <div class="tab-screen-header">
          <h1>Pantry</h1>
          <p class="subtitle">Mark what you're out of</p>
        </div>
        <div class="scroll-body">
          <div class="tab-locked">
            <i data-lucide="archive"></i>
            <h2>Your pantry is empty</h2>
            <p>Add recipes to your saucebook and the ingredients you need will show up here. Tap any row to mark it missing.</p>
            <button class="btn-primary" onclick="setActiveTab('browse')">Open Browse</button>
          </div>
        </div>
      </div>
    `;
  }

  const cats = state.ingredientCategories || {};
  const groups = new Map();
  for (const ing of ings) {
    const cat = cats[(ing.name || '').toLowerCase()] || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(ing);
  }
  // Order: CATEGORY_ORDER first, then anything else alphabetically.
  const ordered = [
    ...CATEGORY_ORDER.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !CATEGORY_ORDER.includes(c)).sort(),
  ];
  const missingCount = ings.filter(i => i.missing).length;

  return `
    <div class="screen-wrap">
      <div class="tab-screen-header">
        <h1>Pantry</h1>
        <p class="subtitle">${ings.length} ingredient${ings.length === 1 ? '' : 's'} from your saucebook · ${missingCount} missing</p>
      </div>
      <div class="scroll-body">
        ${ordered.map(cat => _pantrySection(cat, groups.get(cat))).join('')}
      </div>
    </div>
  `;
}

function _pantrySection(cat, rows) {
  rows = rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return `
    <div class="pantry-section">
      <div class="pantry-section__title">${escapeHtml(cat)}</div>
      ${rows.map(_pantryRow).join('')}
    </div>
  `;
}

function _pantryRow(ing) {
  const missing = !!ing.missing;
  const labelClass = missing ? 'pantry-row__name pantry-row__name--strike' : 'pantry-row__name';
  const stateClass = missing ? 'pantry-row--missing' : 'pantry-row--have';
  return `
    <div class="pantry-row ${stateClass}" onclick="togglePantryMissing('${escapeHtml(ing.foodId)}')">
      <span class="${labelClass}">${escapeHtml(ing.name || '')}</span>
      <span class="pantry-row__state">${missing ? 'Missing' : 'In stock'}</span>
    </div>
  `;
}
