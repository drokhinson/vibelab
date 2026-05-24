'use strict';
// @ts-check

// Canonical Ingredient row. Same domain object (a sauceboss_ingredient
// joined with usage stats), two visual idioms — Pantry's compact row with
// a missing/in-stock toggle, and the Ingredient Manager's expanded row
// with usage stats and edit/delete swipe actions. Before this extraction
// the two surfaces lived as `_pantryRow` (pantry.js) and `renderFoodRow`
// (settings.js) with no shared base.
//
// `ing` is the domain shape from `state.pantry.ingredients` (for pantry
// mode) or from `state.adminFoods` (for manager mode). Both shapes share
// `{ id|ingredientId, name }`; manager mode also reads `usageCount` and
// `sauceCount`; pantry mode reads `missing`.
//
// opts:
//   mode: "pantry" | "manager"      Required.
//   isAdmin?: boolean               Manager only — controls swipe-row chrome.
//   editMode?: boolean              Manager only — gates swipe wrapping.
//   merge?: { keepId, mergeIds }    Manager merge state (Set of picked ids).
//   expanded?: boolean              Manager — show the "used by" sub-panel.
//   panelHTML?: string              Manager — pre-rendered sub-panel HTML.
//   editFormHTML?: string           Manager — when editing this row inline,
//                                   render this instead of the row itself.
function renderIngredientRow(ing, opts = {}) {
  if (opts.mode === 'pantry') return _pantryVariant(ing);
  return _managerVariant(ing, opts);
}

function _pantryVariant(ing) {
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

function _managerVariant(f, opts) {
  // Inline edit form replaces the row entirely.
  if (opts.editFormHTML) {
    return `<div style="padding:0 16px">${opts.editFormHTML}</div>`;
  }
  const safeName = (f.name || '').replace(/'/g, "\\'");
  const usage = f.usageCount || 0;
  const sauces = f.sauceCount || 0;
  const sub = sauces === 0
    ? '<span style="color:var(--text-muted)">unused</span>'
    : `${sauces} sauce${sauces !== 1 ? 's' : ''}`;
  const merge = opts.merge;
  const mergeMode = !!merge;
  const isKeep = merge && merge.keepId === f.id;
  const isPicked = merge && merge.mergeIds.has(f.id);
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

  const panelHTML = opts.panelHTML || '';

  if (!opts.isAdmin || !opts.editMode) {
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
