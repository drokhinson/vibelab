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

// The collapsed type bubble on a scrap card's photo: a tap wobbles it and
// unrolls the label to the right, holds ~2s, then slides shut. Purely
// presentational — one timer per element, restartable after it closes.
const TypeBubble = {
  pop(el) {
    if (!el || el.classList.contains('is-open')) return;
    el.classList.add('is-open');
    clearTimeout(el._closeT);
    el._closeT = setTimeout(() => el.classList.remove('is-open'), 2000);
  },
};
window.TypeBubble = TypeBubble;
