// ui/trip-card.js — canonical Trip render function.
'use strict';

/**
 * @param {Object} trip — TripSummaryResponse
 * @param {{variant?: 'card', index?: number}} opts
 */
function renderTripCard(trip, opts = {}) {
  const { index = 0 } = opts;
  const dates = formatDateRange(trip.start_date, trip.end_date);
  const count = trip.scrap_count ?? 0;
  const washi = ['washi', 'washi washi--mint', 'washi washi--butter', 'washi washi--blush'][index % 4];

  // Trips shared with the viewer (role != owner) get a "Shared by X" ribbon.
  const sharedChip = (trip.role && trip.role !== 'owner')
    ? `<span class="source-badge"><i data-lucide="users"></i>${escapeHtml(trip.owner_display_name ? `Shared by ${trip.owner_display_name}` : 'Shared')}</span>`
    : '';

  return `
    <div class="sticker-card ${washi} card-lift" data-trip-id="${escapeAttr(trip.id)}" style="--i:${index};text-align:center;padding-top:1.4rem;">
      ${renderSprite('cover', trip.cover_icon, { size: 'lg', alt: '' })}
      <h3 style="font-size:1.6rem;margin:0.4rem 0 0.1rem;">${escapeHtml(trip.name)}</h3>
      <div class="scrap-card__sub">${escapeHtml(trip.destination || '')}</div>
      <div class="scrap-card__row" style="justify-content:center;">
        ${dates ? `<span class="source-badge"><i data-lucide="calendar"></i>${escapeHtml(dates)}</span>` : ''}
        <span class="source-badge"><i data-lucide="paperclip"></i>${count} scrap${count === 1 ? '' : 's'}</span>
        ${sharedChip}
      </div>
    </div>
  `;
}
