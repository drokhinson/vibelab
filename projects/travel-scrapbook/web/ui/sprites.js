// ui/sprites.js — custom SVG sprite helpers. This app renders NO emojis:
// every data-art mark is a project SVG under assets/sprites/ (see
// .claude/rules/assets.md § Custom Images, Not Generic Emojis).
'use strict';

const KNOWN_CATEGORY_SPRITES = ['restaurant', 'cafe', 'bar', 'sight', 'activity', 'shop', 'lodging', 'other'];
const KNOWN_COVER_SPRITES = ['plane', 'beach', 'mountain', 'city', 'food', 'roadtrip'];

function categorySpritePath(iconSlug) {
  const slug = KNOWN_CATEGORY_SPRITES.includes(iconSlug) ? iconSlug : 'other';
  return `/assets/sprites/categories/travel-scrapbook-cat-${slug}.svg`;
}

function coverSpritePath(coverSlug) {
  const slug = KNOWN_COVER_SPRITES.includes(coverSlug) ? coverSlug : 'plane';
  return `/assets/sprites/covers/travel-scrapbook-cover-${slug}.svg`;
}

/**
 * Canonical sprite <img> renderer.
 * kind: 'category' | 'cover'; size: 'sm' | 'md' | 'lg' | 'xl'.
 */
function renderSprite(kind, slug, { size = 'md', alt = '' } = {}) {
  const src = kind === 'cover' ? coverSpritePath(slug) : categorySpritePath(slug);
  return `<img class="ts-sprite ts-sprite--${size}" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
}
