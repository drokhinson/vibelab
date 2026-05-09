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
        <div class="tab-screen-header">
          ${renderHeaderAuthSlot()}
          <h1>Pantry</h1>
          <p class="subtitle">Mark what you're out of</p>
        </div>
        <div class="scroll-body">
          <div class="loading-inline"><div class="loading-pot">${potSVG()}</div><p class="loading-text">Saucing…</p></div>
        </div>
      </div>
    `;
  }
  if (ings.length === 0) {
    return `
      <div class="screen-wrap">
        <div class="tab-screen-header">
          ${renderHeaderAuthSlot()}
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
  const totalMissing = ings.filter(i => i.missing).length;

  return `
    <div class="screen-wrap">
      <div class="tab-screen-header">
        ${renderHeaderAuthSlot()}
        <h1>Pantry</h1>
        <p class="subtitle">${ings.length} ingredient${ings.length === 1 ? '' : 's'} from your saucebook · ${totalMissing} missing</p>
      </div>
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
  const badgeClass = missingInCat > 0 ? 'pantry-section__count pantry-section__count--missing' : 'pantry-section__count';
  return `
    <div class="pantry-section">
      <button class="pantry-section__header" onclick="pantryToggleSection('${escapeHtml(cat)}')">
        <span class="pantry-section__chevron">${open ? '▾' : '▸'}</span>
        <span class="pantry-section__title">${escapeHtml(cat)}</span>
        <span class="${badgeClass}">${missingInCat}/${total} missing</span>
      </button>
      ${open ? `<div class="pantry-section__body">${rows.map(_pantryRow).join('')}</div>` : ''}
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

function pantryToggleSection(cat) {
  const open = _pantrySectionState();
  if (open.has(cat)) open.delete(cat);
  else open.add(cat);
  render();
}
