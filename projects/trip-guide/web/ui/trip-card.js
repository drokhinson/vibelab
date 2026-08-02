// ui/trip-card.js — canonical render function for the Trip object (list surface).
// renderTripCard(trip, opts) → HTML string. opts: { palette, isAdmin }.
(function () {
  function renderTripCard(trip, opts = {}) {
    const esc = window.escapeHtml;
    const p = opts.palette || {};
    const primary = p.primary || "#3f3f46";
    const accent = p.accent || "#a1a1aa";
    const count = trip.stop_count || 0;
    const countLabel = `${count} ${count === 1 ? "stop" : "stops"}`;

    const adminActions = opts.isAdmin
      ? `<div class="tg-trip-card__actions">
           <button class="btn btn-xs btn-ghost" data-edit-trip="${esc(trip.id)}" aria-label="Edit trip"><i data-lucide="pencil"></i></button>
           <button class="btn btn-xs btn-ghost tg-danger" data-delete-trip="${esc(trip.id)}" aria-label="Delete trip"><i data-lucide="trash-2"></i></button>
         </div>`
      : "";

    return `
      <article class="tg-trip-card" data-trip-id="${esc(trip.id)}"
               style="--card-primary:${esc(primary)};--card-accent:${esc(accent)}">
        <div class="tg-trip-card__swatch" aria-hidden="true"></div>
        <div class="tg-trip-card__body">
          <h3 class="tg-trip-card__name">${esc(trip.name)}</h3>
          ${trip.description ? `<p class="tg-trip-card__desc">${esc(trip.description)}</p>` : ""}
          <span class="tg-trip-card__meta"><i data-lucide="map-pin"></i>${countLabel}</span>
        </div>
        ${adminActions}
        <i data-lucide="chevron-right" class="tg-trip-card__chev" aria-hidden="true"></i>
      </article>`;
  }

  window.renderTripCard = renderTripCard;
})();
