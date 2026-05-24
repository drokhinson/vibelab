'use strict';
// @ts-check

// Canonical Dish tile. Same domain object — a sauceboss_dish with optional
// variants/subtypes — rendered as a tile in the meal flow and as a row in
// the Dish Manager. Before this extraction the two surfaces used parallel
// implementations: meal.js inline `.carb-card` markup vs settings.js
// `renderParent` / `renderVariantRow`. Both surfaces still mount inside the
// same containers (`.carb-grid` for tiles, `.ingredient-category-group`
// accordion for manager rows); this helper just owns the per-item markup.
//
// `dish` is `{ id, name, emoji?, subtypes?, variants?, description?,
//             cookTimeMinutes?, instructions? }` — backend may return
// subtypes OR variants depending on category; treat as the same shape.
//
// opts.variant:
//   "tile"          Meal-flow tile grid (.carb-card with --i stagger).
//   "subtype-tile"  Subtype picker tile (variant of "tile"; same chrome).
//   "manager-row"   Dish Manager parent row with expand chevron.
//   "variant-row"   Dish Manager indented child variant.
//
// Manager-row / variant-row opts:
//   isAdmin: boolean    Whether to render swipe-row chrome.
//   editMode: boolean   Gates swipe wrapping (admin-only).
//   expanded: boolean   Manager parent — whether children are visible.
//   canExpand: boolean  Manager parent — show chevron and enable tap.
//   onTap: string       Manager parent — JS expression for tap handler.
//   subline: string     Manager — pre-formatted "N variants · 12 min" etc.
//   safeName: string    Manager — already-escaped name for swipe data attrs.
//   hasVariants: boolean Manager parent — used by delete confirmation.
//   indent: boolean     Variant row — controls left padding.
//
// Tile opts:
//   index: number       Stagger index for the --i CSS var.
//   onClick: string     JS expression for the button's onclick.
//   subline: string     Optional manual subline (overrides the default).
function renderDishTile(dish, opts = {}) {
  const variant = opts.variant || 'tile';
  if (variant === 'tile' || variant === 'subtype-tile') return _tileVariant(dish, opts);
  if (variant === 'manager-row') return _managerParentVariant(dish, opts);
  if (variant === 'variant-row') return _managerVariantRow(dish, opts);
  return '';
}

function _tileVariant(d, opts) {
  const index = opts.index || 0;
  const subs = Array.isArray(d.subtypes) ? d.subtypes : (d.variants || []);
  const subline = opts.subline != null
    ? opts.subline
    : (subs.length > 0
        ? `${subs.length} subtype${subs.length === 1 ? '' : 's'}`
        : (d.description || (d.cookTimeMinutes ? `${d.cookTimeMinutes} min` : '')));
  const sublineHTML = subline ? `<div class="carb-desc">${escapeHtml(subline)}</div>` : '';
  const onClick = opts.onClick || '';
  return `
    <button class="carb-card" style="--i:${index}" onclick="${onClick}">
      <span class="carb-emoji">${d.emoji || '🍽'}</span>
      <div class="carb-name">${escapeHtml(d.name)}</div>
      ${sublineHTML}
    </button>`;
}

function _managerParentVariant(parent, opts) {
  const canExpand = !!opts.canExpand;
  const expanded = !!opts.expanded;
  const sub = opts.subline || '';
  const parentRowStyle = `padding:10px 16px;border-top:1px solid #f0e6d6;display:flex;align-items:center;gap:8px;cursor:${canExpand ? 'pointer' : 'default'}`;
  const inner = `
      <span class="parent-chevron" style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;${canExpand ? '' : 'visibility:hidden'}"><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}"></i></span>
      <span class="sm-carb-emoji">${parent.emoji || ''}</span>
      <div class="admin-sauce-info" style="flex:1">
        <div class="admin-sauce-name">${parent.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>`;
  const showSwipe = !!(opts.isAdmin && opts.editMode);
  if (!showSwipe) {
    return `<div class="admin-parent-row" style="${parentRowStyle}" ${canExpand ? `onclick="${opts.onTap || ''}"` : ''}>${inner}</div>`;
  }
  return `<div class="swipe-row" data-swipe
       ${canExpand ? `data-tap-action="${opts.onTap || ''}"` : ''}
       data-edit-action="openEditItemFormById('${parent.id}')"
       data-delete-action="adminDeleteItemAction('${parent.id}','${opts.safeName || ''}',${opts.hasVariants ? 'true' : 'false'})">
    <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
    <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
    <div class="swipe-content admin-parent-row" style="${parentRowStyle}">${inner}</div>
  </div>`;
}

function _managerVariantRow(v, opts) {
  const sub = opts.subline || '';
  const inner = `
      <span class="sm-carb-emoji">${v.emoji || ''}</span>
      <div class="admin-sauce-info">
        <div class="admin-sauce-name">${v.name}</div>
        <div class="admin-sauce-carbs">${sub}</div>
      </div>`;
  if (!opts.isAdmin || !opts.editMode) {
    return `<div class="admin-sauce-row" style="padding-left:38px">${inner}</div>`;
  }
  return `
    <div class="swipe-row" data-swipe
         data-edit-action="openEditItemFormById('${v.id}')"
         data-delete-action="adminDeleteItemAction('${v.id}','${opts.safeName || ''}',false)">
      <div class="swipe-action swipe-action-edit"   aria-hidden="true">Edit</div>
      <div class="swipe-action swipe-action-delete" aria-hidden="true">Delete</div>
      <div class="swipe-content admin-sauce-row" style="padding-left:38px">${inner}</div>
    </div>`;
}
