'use strict';

// Accordion group shared by Saucebook, Sauce Selector, Sauce Manager, Dish
// Manager, and Ingredient Manager. Renders the orange uppercase header +
// flush body using the existing `.ingredient-category-*` classes. `body` is
// the already-rendered rows HTML (caller decides what to put inside).
function renderAccordionGroup(opts) {
  const { label, count, isOpen, onToggle, body, emoji } = opts;
  const chevron = isOpen ? '▾' : '▸';
  return `
    <div class="ingredient-category-group">
      <div class="ingredient-category-header" onclick="${onToggle}">
        <span class="ingredient-category-chevron">${chevron}</span>
        ${emoji ? `<span class="cuisine-flag-emoji">${emoji}</span>` : ''}
        <span class="ingredient-category-name">${escapeHtml(label)}</span>
        <span class="ingredient-category-count">${count}</span>
      </div>
      ${isOpen ? `<div class="ingredient-category-body">${body}</div>` : ''}
    </div>
  `;
}
