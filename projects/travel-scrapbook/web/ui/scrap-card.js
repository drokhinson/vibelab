// ui/scrap-card.js — canonical Scrap render function (all statuses).
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

/**
 * @param {Scrap} scrap
 * @param {{index?: number}} opts
 */
function renderScrapCard(scrap, opts = {}) {
  const { index = 0 } = opts;
  const catIcon = _scrapCategoryIcon(scrap);

  if (scrap.status === 'pending') {
    return `
      <div class="sticker-card scrap-card--pending" style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}">
        <div class="scrap-card__photo"></div>
        <div class="scrap-card__title shimmer" style="height:1rem;border-radius:6px;width:70%;"></div>
        <div class="scrap-card__row">
          <span class="source-badge"><i data-lucide="sparkles"></i>reading the page…</span>
          <span class="source-badge">${escapeHtml(scrap.source_domain || '')}</span>
        </div>
      </div>
    `;
  }

  if (scrap.status === 'failed') {
    return `
      <div class="sticker-card scrap-card--failed" style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}">
        <div class="scrap-card__sprite-fallback">${renderSprite('category', catIcon, { size: 'lg' })}</div>
        <p class="scrap-card__title">Couldn't read this one</p>
        <p class="scrap-card__sub">${escapeHtml(scrap.source_url)}</p>
        <div class="scrap-card__row">
          <button class="ts-btn ts-btn--sm ts-btn--mint" data-action="retry" data-scrap-id="${escapeAttr(scrap.id)}">
            <i data-lucide="rotate-ccw"></i>Try again
          </button>
          <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="edit" data-scrap-id="${escapeAttr(scrap.id)}">
            <i data-lucide="pencil"></i>Fill in by hand
          </button>
          <button class="ts-btn ts-btn--sm ts-btn--ghost" data-action="delete" data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Delete">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    `;
  }

  const title = scrap.place_name || scrap.og_title || scrap.source_domain || 'Saved place';
  const sub = [scrap.place_city, scrap.place_country].filter(Boolean).join(', ');
  const hint = _confidenceHint(scrap);
  const photo = scrap.og_image_url
    ? `<img class="scrap-card__photo" src="${escapeAttr(scrap.og_image_url)}" alt="" loading="lazy"
         onerror="this.outerHTML='<div class=&quot;scrap-card__sprite-fallback&quot;>${renderSprite('category', catIcon, { size: 'lg' }).replaceAll('"', '&quot;')}</div>'" />`
    : `<div class="scrap-card__sprite-fallback">${renderSprite('category', catIcon, { size: 'lg' })}</div>`;

  return `
    <div class="sticker-card card-lift" style="--i:${index};" data-scrap-id="${escapeAttr(scrap.id)}" data-action="edit">
      <div class="scrap-card__actions">
        <button class="scrap-card__fav ${scrap.is_favorite ? 'is-fav' : ''}" data-action="favorite"
                data-scrap-id="${escapeAttr(scrap.id)}" aria-label="Favorite">
          <i data-lucide="heart"></i>
        </button>
      </div>
      ${photo}
      <p class="scrap-card__title">${escapeHtml(title)}</p>
      ${sub ? `<p class="scrap-card__sub">${escapeHtml(sub)}</p>` : ''}
      <div class="scrap-card__row">
        ${renderCategoryBadge(scrap.category)}
        <span class="source-badge"><i data-lucide="link-2"></i>${escapeHtml(scrap.source_domain || 'link')}</span>
        ${scrap.maps_url ? `<a class="source-badge" href="${escapeAttr(scrap.maps_url)}" target="_blank" rel="noopener" data-action="none" onclick="event.stopPropagation()"><i data-lucide="map-pin"></i>Maps</a>` : ''}
      </div>
      ${hint ? `<div class="confidence-hint" style="margin-top:0.4rem;">${escapeHtml(hint)}</div>` : ''}
      ${scrap.notes ? `<p class="scrap-card__sub" style="margin-top:0.4rem;">${escapeHtml(scrap.notes)}</p>` : ''}
    </div>
  `;
}
