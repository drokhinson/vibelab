// ui/scrap-card.js — canonical Scrap render function.
// A scrap is a saved PLACE (the source of truth); the URLs it arrived from
// render as source chips. Variants: 'trip' (default), 'staged' (approve /
// move-to-inbox row), 'inbox' (trip-suggestion chips + picker hooks).
'use strict';

function _scrapCategoryIcon(scrap) {
  const categories = window.store.get('categories') || [];
  return (categories.find((c) => c.slug === scrap.category) || { icon: 'other' }).icon;
}

function _confidenceHint(scrap) {
  if (scrap.geocode_confidence === 'none') return 'not on the map yet — tap to edit';
  if (scrap.geocode_confidence === 'low') return 'rough location (city only)';
  if (scrap.geocode_confidence === 'medium') return 'approximate location';
  return '';
}

function _sourceChips(scrap) {
  const sources = scrap.sources || [];
  return sources.map((src) => `
    <a class="source-badge" href="${escapeAttr(src.url)}" target="_blank" rel="noopener"
       title="${escapeAttr(src.og_title || src.url)}" onclick="event.stopPropagation()">
      <i data-lucide="link-2"></i>${escapeHtml(src.source_domain || 'link')}
    </a>`).join('');
}

/**
 * @param {Scrap} scrap
 * @param {{index?: number, variant?: 'trip'|'staged'|'inbox'}} opts
 */
function renderScrapCard(scrap, opts = {}) {
  const { index = 0, variant = 'trip' } = opts;
  const catIcon = _scrapCategoryIcon(scrap);

  const title = scrap.place_name || 'Saved place';
  const sub = [scrap.place_city, scrap.place_country].filter(Boolean).join(', ');
  const hint = _confidenceHint(scrap);
  const photo = scrap.og_image_url
    ? `<img class="scrap-card__photo" src="${escapeAttr(scrap.og_image_url)}" alt="" loading="lazy"
         onerror="this.outerHTML='<div class=&quot;scrap-card__sprite-fallback&quot;>${renderSprite('category', catIcon, { size: 'lg' }).replaceAll('"', '&quot;')}</div>'" />`
    : `<div class="scrap-card__sprite-fallback">${renderSprite('category', catIcon, { size: 'lg' })}</div>`;

  let footer = '';
  if (variant === 'staged') {
    footer = `
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="approve" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="check"></i>Keep it
        </button>
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="unassign" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="inbox"></i>Move to inbox
        </button>
      </div>`;
  } else if (variant === 'inbox') {
    const chips = (scrap.suggestions || []).map((sug) => `
      <button class="ts-btn ts-btn--sm ts-btn--sky" data-action="assign"
              data-scrap-id="${escapeAttr(scrap.id)}" data-trip-id="${escapeAttr(sug.trip_id)}">
        <i data-lucide="plus"></i>${escapeHtml(sug.name)} · ${formatKm(sug.distance_km)}
      </button>`).join('');
    footer = `
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        ${chips}
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="pick-trip" data-scrap-id="${escapeAttr(scrap.id)}">
          <i data-lucide="folder-plus"></i>Pick a trip
        </button>
        <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="delete" data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Delete">
          <i data-lucide="trash-2"></i>
        </button>
      </div>`;
  }

  const favBtn = variant === 'trip' ? `
    <div class="scrap-card__actions">
      <button class="scrap-card__fav ${scrap.is_favorite ? 'is-fav' : ''}" data-action="favorite"
              data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Favorite">
        <i data-lucide="heart"></i>
      </button>
    </div>` : '';

  return `
    <div class="sticker-card card-lift ${variant === 'staged' ? 'scrap-card--staged' : ''}"
         style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}" data-action="edit">
      ${favBtn}
      ${photo}
      <p class="scrap-card__title">${escapeHtml(title)}</p>
      ${sub ? `<p class="scrap-card__sub">${escapeHtml(sub)}</p>` : ''}
      <div class="scrap-card__row">
        ${renderCategoryBadge(scrap.category)}
        ${_sourceChips(scrap)}
        ${scrap.maps_url ? `<a class="source-badge" href="${escapeAttr(scrap.maps_url)}" target="_blank" rel="noopener" data-action="none" onclick="event.stopPropagation()"><i data-lucide="map-pin"></i>Maps</a>` : ''}
      </div>
      ${hint ? `<div class="confidence-hint" style="margin-top:0.4rem;">${escapeHtml(hint)}</div>` : ''}
      ${scrap.notes ? `<p class="scrap-card__sub" style="margin-top:0.4rem;">${escapeHtml(scrap.notes)}</p>` : ''}
      ${footer}
    </div>
  `;
}
