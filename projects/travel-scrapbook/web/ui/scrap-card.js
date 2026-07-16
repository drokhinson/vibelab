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

// City, Country, dropping empties and an adjacent duplicate (a city-centroid
// geocode sometimes repeats the name, e.g. Singapore). Region is a grouping of
// countries (macro-region), used only for grouping — not shown inline.
function _locationLine(scrap) {
  const parts = [];
  for (const seg of [scrap.place_city, scrap.place_country]) {
    if (seg && seg !== parts[parts.length - 1]) parts.push(seg);
  }
  return parts.join(', ');
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
 * @param {{index?: number, variant?: 'trip'|'staged'|'inbox'|'candidate'|'preview', tripId?: string}} opts
 */
function renderScrapCard(scrap, opts = {}) {
  const { index = 0, variant = 'trip', tripId = null } = opts;
  // 'preview' = read-only display (e.g. the share success screen): no actions,
  // toggles, or click-to-edit, since it has no trip/store context.
  const isPreview = variant === 'preview';
  const catIcon = _scrapCategoryIcon(scrap);

  const title = scrap.place_name || 'Saved place';
  const sub = _locationLine(scrap);
  const hint = _confidenceHint(scrap);
  // Prefer the source's og:image; else a static map of the pin (geocoded places
  // only); else the category sprite. The onerror covers a provider hiccup or a
  // dead image URL by swapping in the sprite.
  const imgSrc = scrap.og_image_url ||
    (scrap.lat != null ? staticMapUrl(scrap.lat, scrap.lng) : null);
  const photo = imgSrc
    ? `<img class="scrap-card__photo" src="${escapeAttr(imgSrc)}" alt="" loading="lazy"
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
  } else if (variant === 'candidate') {
    footer = `
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="assign"
                data-scrap-id="${escapeAttr(scrap.id)}" data-trip-id="${escapeAttr(tripId)}">
          <i data-lucide="plus"></i>Add to this trip
        </button>
      </div>`;
  }

  // Favorite (trip only) + visited toggle (trip + wishlist) live in the corner.
  const showFav = variant === 'trip';
  const showVisited = variant === 'trip' || variant === 'inbox';
  const isVisited = !!scrap.visited_at && !isPreview;
  const actions = (showFav || showVisited) ? `
    <div class="scrap-card__actions">
      ${showVisited ? `
        <button class="scrap-card__visited ${isVisited ? 'is-visited' : ''}" data-action="visited"
                data-scrap-id="${escapeAttr(scrap.id)}"
                aria-label="${isVisited ? 'Mark not visited' : 'Mark visited'}"
                title="${isVisited ? 'Visited — tap to undo' : 'Mark visited'}">
          <i data-lucide="circle-check"></i>
        </button>` : ''}
      ${showFav ? `
        <button class="scrap-card__fav ${scrap.is_favorite ? 'is-fav' : ''}" data-action="favorite"
                data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Favorite">
          <i data-lucide="heart"></i>
        </button>` : ''}
    </div>` : '';

  return `
    <div class="sticker-card ${isPreview ? '' : 'card-lift'} ${variant === 'staged' ? 'scrap-card--staged' : ''} ${isVisited ? 'is-visited' : ''}"
         style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}" data-action="${isPreview ? 'none' : 'edit'}">
      ${actions}
      ${isVisited ? '<span class="scrap-card__visited-badge"><i data-lucide="check"></i>Visited</span>' : ''}
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
