// ui/category-badge.js — canonical Category chip (sprite + label).
'use strict';

function renderCategoryBadge(categorySlug, { showLabel = true } = {}) {
  const categories = window.store.get('categories') || [];
  const cat = categories.find((c) => c.slug === categorySlug) ||
    { slug: 'other', label: 'Other', icon: 'other' };
  return `
    <span class="category-badge" title="${escapeAttr(cat.label)}">
      ${renderSprite('category', cat.icon, { size: 'sm', alt: cat.label })}
      ${showLabel ? `<span>${escapeHtml(cat.label)}</span>` : ''}
    </span>
  `;
}
