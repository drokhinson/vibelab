'use strict';
// @ts-check
//
// Pantry tab — negative ingredient list. Surfaces every food appearing in
// the user's saucebook recipes; tapping a row toggles its missing flag and
// persists to /pantry. The same backing store is read by the meal-builder's
// ingredient filter, so changes here update which sauces show as
// missing-X-and-Y over there (and vice versa).
//
// Sections collapse by default. Each section header surfaces a count badge:
//   • "0/12"  — none missing in this category (no badge, just total)
//   • "3/12"  — 3 of 12 ingredients in this category are missing
// Tapping the header expands the section so the user can mark items.

function renderPantry() {
  const ings = state.pantry.ingredients || [];
  // Pantry is loaded in the background after the splash drops. Render the
  // inline pot animation if the user reaches this tab before the fetch
  // resolves, so the empty-state ("Your pantry is empty") only shows for
  // users who genuinely have no saucebook ingredients.
  const isHydrating = currentUser && (state.pantry.loading || !state.pantry._loaded);
  if (isHydrating && ings.length === 0) {
    return `
      <div class="screen-wrap">
        ${renderAppHeader({ title: 'Pantry', subtitle: "Mark what you're out of" })}
        <div class="scroll-body">
          <div class="loading-inline"><div class="loading-pot">${potSVG()}</div><p class="loading-text">Saucing…</p></div>
        </div>
      </div>
    `;
  }
  if (ings.length === 0) {
    return `
      <div class="screen-wrap">
        ${renderAppHeader({ title: 'Pantry', subtitle: "Mark what you're out of" })}
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

  // Each pantry row carries its category inline (joined from
  // sauceboss_ingredient.category by migration 015) so we don't need to
  // cross-reference state.ingredientCategories here. NULL means uncategorized.
  const groups = new Map();
  for (const ing of ings) {
    const cat = ing.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(ing);
  }
  // Order: CATEGORY_ORDER first, then anything else alphabetically.
  const ordered = [
    ...CATEGORY_ORDER.filter(c => groups.has(c)),
    ...[...groups.keys()].filter(c => !CATEGORY_ORDER.includes(c)).sort(),
  ];
  const totalMissing = ings.filter(i => i.missing).length;

  return `
    <div class="screen-wrap">
      ${renderAppHeader({
        title: 'Pantry',
        subtitle: `${ings.length} saucebook ingredient${ings.length === 1 ? '' : 's'} · ${totalMissing} missing`,
      })}
      <div class="scroll-body">
        ${ordered.map(cat => _pantrySection(cat, groups.get(cat))).join('')}
      </div>
    </div>
  `;
}

function _pantrySectionState() {
  // Lazy-init: each pantry category is collapsed by default. We track the
  // open ones in a Set on `state.pantry.openSections`.
  if (!state.pantry.openSections) state.pantry.openSections = new Set();
  return state.pantry.openSections;
}

function _pantrySection(cat, rows) {
  rows = rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const open = _pantrySectionState().has(cat);
  const missingInCat = rows.filter(r => r.missing).length;
  const total = rows.length;
  const inStock = total - missingInCat;
  const countClass = missingInCat > 0
    ? 'ingredient-category-count ingredient-category-count--missing'
    : 'ingredient-category-count';
  return `
    <div class="ingredient-category-group">
      <div class="ingredient-category-header" onclick="pantryToggleSection('${escapeHtml(cat)}')">
        <span class="ingredient-category-chevron">${open ? '▾' : '▸'}</span>
        <span class="ingredient-category-name">${escapeHtml(cat)}</span>
        <span class="${countClass}">${inStock}/${total}</span>
      </div>
      ${open ? `<div class="ingredient-category-body">${rows.map(_pantryRow).join('')}</div>` : ''}
    </div>
  `;
}

// `_pantryRow` was collapsed into the canonical `renderIngredientRow`
// in 2026-05-24 (ui/ingredient-row.js).
const _pantryRow = (ing) => renderIngredientRow(ing, { mode: 'pantry' });

function pantryToggleSection(cat) {
  const open = _pantrySectionState();
  if (open.has(cat)) open.delete(cat);
  else open.add(cat);
  render();
}
