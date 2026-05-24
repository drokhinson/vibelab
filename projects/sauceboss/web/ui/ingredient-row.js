'use strict';
// @ts-check
//
// Canonical Ingredient row component. Single entry point for rendering an
// ingredient as a row anywhere in the app. Two modes today; a third surface
// would add a third mode rather than build its own markup.
//
//   renderIngredientRow(ing, { mode: 'pantry' })
//     → compact row with name + "Missing"/"In stock" state pill; tap toggles
//       the missing flag. Used by the Pantry tab.
//
//   renderIngredientRow(ing, { mode: 'manager', isAdmin, merge })
//     → card row with usage subline. In admin edit mode, wraps the row in a
//       swipe-row with Edit/Delete actions. In merge mode, applies keep/merge
//       tags and routes taps to toggleFoodMergePick. Tap (non-merge) toggles
//       the expandable sauces panel. Used by the admin Ingredient Manager.
//
// The two modes use different CSS class families (.pantry-row* vs .food-row*)
// because the surfaces have legitimately different visual targets — the audit
// (UI_AUDIT.md §5b) chose to keep both rather than force a unified visual.
// This component centralizes the markup so the choice is one named opt, not
// two divergent files.

/**
 * @typedef {Object} Ingredient
 * @property {string} [ingredientId]
 * @property {string} [id]
 * @property {string} [name]
 * @property {boolean} [missing]
 * @property {number} [usageCount]
 * @property {number} [sauceCount]
 */

/**
 * @typedef {{ mode: 'pantry' }} PantryOpts
 * @typedef {{ mode: 'manager', isAdmin: boolean, merge?: { keepId: string, mergeIds: Set<string> } | null }} ManagerOpts
 */

/**
 * @param {Ingredient} ing
 * @param {PantryOpts | ManagerOpts} opts
 * @returns {string}
 */
function renderIngredientRow(ing, opts) {
  const mode = opts && opts.mode;
  if (mode === 'pantry') return _ingredientRowPantry(ing);
  if (mode === 'manager') return _ingredientRowManager(ing, opts.isAdmin, opts.merge);
  throw new Error(`renderIngredientRow: unknown mode "${mode}"`);
}

function _ingredientRowPantry(ing) {
  const missing = !!ing.missing;
  const rowClass = missing ? 'pantry-row pantry-row--missing' : 'pantry-row';
  const nameClass = missing ? 'pantry-row__name pantry-row__name--strike' : 'pantry-row__name';
  return `
    <div class="${rowClass}" onclick="togglePantryMissing('${escapeHtml(ing.ingredientId)}')">
      <span class="${nameClass}">${escapeHtml(ing.name || '')}</span>
      <span class="pantry-row__state">${missing ? 'Missing' : 'In stock'}</span>
    </div>
  `;
}

function _ingredientRowManager(f, isAdmin, merge) {
  // Inline edit: if this food is being edited, show the form in place
  const form = state.foodForm;
  if (isAdmin && form && form.mode === 'edit' && form.id === f.id) {
    return `<div style="padding:0 16px">${renderFoodForm()}</div>`;
  }
  const safeName = (f.name || '').replace(/'/g, "\\'");
  const usage = f.usageCount || 0;
  const sauces = f.sauceCount || 0;
  const sub = sauces === 0
    ? '<span style="color:#888">unused</span>'
    : `${sauces} sauce${sauces !== 1 ? 's' : ''}`;
  const mergeMode = !!merge;
  const isKeep = merge && merge.keepId === f.id;
  const isPicked = merge && merge.mergeIds.has(f.id);
  const expanded = !mergeMode && state.expandedFoodIds && state.expandedFoodIds.has(f.id);
  const inner = `
    <div class="admin-sauce-info" style="flex:1">
      <div class="admin-sauce-name">${f.name}</div>
      <div class="admin-sauce-carbs">${sub}</div>
    </div>
    ${mergeMode ? `
      ${isKeep ? '<span class="food-merge-tag food-merge-tag-keep">keep</span>'
              : isPicked ? '<span class="food-merge-tag food-merge-tag-merge">will merge</span>'
              : ''}
    ` : ''}`;

  if (mergeMode) {
    return `<div class="food-row${isKeep ? ' food-row-keep' : ''}${isPicked ? ' food-row-picked' : ''}"
                 onclick="toggleFoodMergePick('${f.id}')">${inner}</div>`;
  }

  const panelHTML = expanded ? renderIngredientSaucesPanel(f.id) : '';

  if (!isAdmin || !state.editMode) {
    return `
      <div class="food-row" onclick="toggleFoodExpand('${f.id}')">${inner}</div>
      ${panelHTML}`;
  }
  return `
    <div class="swipe-row" data-swipe
         data-tap-action="toggleFoodExpand('${f.id}')"
         data-longpress-action="startFoodMerge('${f.id}')"
         data-edit-action="openFoodForm('${f.id}')"
         data-delete-action="adminDeleteIngredientAction('${f.id}','${safeName}',${usage})">
      <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
      <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
      <div class="swipe-content food-row">${inner}</div>
    </div>
    ${panelHTML}`;
}

window.renderIngredientRow = renderIngredientRow;
