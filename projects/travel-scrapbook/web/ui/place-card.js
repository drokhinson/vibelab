// ui/place-card.js — canonical render function for a community Place
// aggregate: photo/static-map, name, location, save count, sample source
// chips, and an Add button ([data-action=save-community]).
'use strict';

/**
 * @param {object} place - CommunityPlaceResponse
 * @param {{index?: number, saved?: boolean}} opts
 *   saved — already on the viewer's lists; renders a check instead of Add.
 */
function renderPlaceCard(place, { index = 0, saved = false } = {}) {
  const categories = window.store.get('categories') || [];
  const catIcon = (categories.find((c) => c.slug === place.category) || { icon: 'other' }).icon;
  const imgSrc = place.og_image_url ||
    (place.lat != null ? staticMapUrl(place.lat, place.lng) : null);
  const photo = imgSrc
    ? `<img class="scrap-card__photo" src="${escapeAttr(imgSrc)}" alt="" loading="lazy"
         onerror="this.outerHTML='<div class=&quot;scrap-card__sprite-fallback&quot;>${renderSprite('category', catIcon, { size: 'lg' }).replaceAll('"', '&quot;')}</div>'" />`
    : `<div class="scrap-card__sprite-fallback">${renderSprite('category', catIcon, { size: 'lg' })}</div>`;
  const location = [place.city, place.country].filter(Boolean).join(', ');
  const chips = (place.sample_sources || []).map((src) => `
    <a class="source-badge" href="${escapeAttr(src.url)}" target="_blank" rel="noopener"
       title="${escapeAttr(src.og_title || src.url)}" onclick="event.stopPropagation()">
      <i data-lucide="link-2"></i>${escapeHtml(src.source_domain || 'link')}
    </a>`).join('');
  const n = place.saved_by_count || 1;
  return `
    <div class="sticker-card" style="--i:${index};">
      ${photo}
      <p class="scrap-card__title">${escapeHtml(place.name)}</p>
      ${location ? `<p class="scrap-card__sub">${escapeHtml(location)}</p>` : ''}
      <p class="scrap-card__sub"><i data-lucide="users" style="width:13px;height:13px;"></i>
        Saved by ${n} traveler${n === 1 ? '' : 's'}</p>
      <div class="scrap-card__row">
        ${renderCategoryBadge(place.category)}
        ${chips}
        ${place.maps_url ? `<a class="source-badge" href="${escapeAttr(place.maps_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i data-lucide="map-pin"></i>Maps</a>` : ''}
      </div>
      <div class="scrap-card__row" style="margin-top:0.6rem;">
        ${saved
          ? `<span class="ts-btn ts-btn--ghost ts-btn--sm" aria-disabled="true" style="opacity:0.6;"><i data-lucide="check"></i>Saved</span>`
          : `<button class="ts-btn ts-btn--mint ts-btn--sm" data-action="save-community" data-place-id="${escapeAttr(place.ref_place_id)}">
              <i data-lucide="plus"></i>Add
            </button>`}
      </div>
    </div>
  `;
}
