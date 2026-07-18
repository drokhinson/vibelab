// ui/category-badge.js — the collapsed type bubble shown on a scrap card's photo.
'use strict';

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
