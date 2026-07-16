// ui/route-panel.js — the trip Route panel: sorted stop list, per-leg
// distances, and the Google Maps / CSV export buttons. Render-only; the
// buttons (#route-optimize, #route-maps, #route-csv) are bound by trip-view.
'use strict';

/**
 * @param {object} trip - Trip with anchors.
 * @param {object} opts
 * @param {object|null} opts.route - RouteOptimizeResponse, once sorted.
 * @param {number} opts.geocodedCount - Trip scraps with map pins.
 * @param {boolean} opts.canWrite - Owner/collaborator (shows the sort button).
 * @param {boolean} opts.routeBusy - Disables the sort button while running.
 * @returns {string} HTML ('' when there is nothing to route yet).
 */
function renderRoutePanel(trip, { route = null, geocodedCount = 0, canWrite = true, routeBusy = false } = {}) {
  if (geocodedCount < 2 && !route) return '';
  let body = '';
  if (route) {
    const r = route;
    const stops = [];
    const anchors = trip.anchors || [];
    const start = anchors.find((a) => a.role === 'start' && a.lat != null) ||
                  anchors.find((a) => a.role === 'stay' && a.lat != null);
    const end = anchors.find((a) => a.role === 'end' && a.lat != null);
    if (start) stops.push({ label: start.label, isAnchor: true });
    r.ordered_scraps.forEach((s) => stops.push({ label: s.place_name || 'Stop' }));
    if (end) stops.push({ label: end.label, isAnchor: true });
    let n = 0;
    body = `
      <div style="margin-top:0.8rem;">
        ${stops.map((stop, i) => {
          if (!stop.isAnchor) n += 1;
          const legKm = i < r.legs.length ? r.legs[i].distance_km : null;
          return renderRouteStop(stop, n, { legKm });
        }).join('')}
        <p class="scrap-card__sub" style="margin-top:0.5rem;">Total: ${formatKm(r.total_km)}
          ${r.skipped_scrap_ids.length ? ` · ${r.skipped_scrap_ids.length} scrap${r.skipped_scrap_ids.length === 1 ? '' : 's'} skipped (no map pin yet)` : ''}</p>
        <div style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-top:0.7rem;">
          <button class="ts-btn ts-btn--sky ts-btn--sm" id="route-maps"><i data-lucide="map"></i>Open in Google Maps</button>
          <button class="ts-btn ts-btn--ghost ts-btn--sm" id="route-csv"><i data-lucide="download"></i>CSV for My Maps</button>
        </div>
        <div id="route-legs" style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem;"></div>
      </div>
    `;
  }
  return `
    <div class="sticker-card washi washi--butter" style="padding-top:1.2rem;margin-top:1.1rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;">
        <div>
          <h2 style="font-size:1.5rem;margin:0;">Route</h2>
          <p class="scrap-card__sub">${geocodedCount} place${geocodedCount === 1 ? '' : 's'} on the map</p>
        </div>
        ${canWrite ? `<button class="ts-btn ts-btn--mint ts-btn--sm" id="route-optimize" ${routeBusy ? 'disabled' : ''}>
          <i data-lucide="wand-2"></i>${route ? 'Re-sort' : 'Sort my route'}
        </button>` : ''}
      </div>
      ${body}
    </div>
  `;
}
window.renderRoutePanel = renderRoutePanel;
