// ui/route-stop.js — canonical Route stop row (numbered sticker + leg distance).
'use strict';

/**
 * @param {{label: string, isAnchor?: boolean}} stop
 * @param {number} n — 1-based stop number (anchors render a pin instead)
 * @param {{legKm?: number|null}} opts — distance to the NEXT stop
 */
function renderRouteStop(stop, n, opts = {}) {
  const num = stop.isAnchor
    ? `<span class="route-stop__num route-stop__num--anchor"><i data-lucide="flag"></i></span>`
    : `<span class="route-stop__num">${n}</span>`;
  const leg = opts.legKm != null
    ? `<div class="route-stop__leg"><i data-lucide="footprints" style="width:12px;height:12px;"></i> ${formatKm(opts.legKm)}</div>`
    : '';
  return `
    <div class="route-stop">
      ${num}
      <div style="min-width:0;flex:1;">
        <div style="font-weight:800;">${escapeHtml(stop.label)}</div>
      </div>
    </div>
    ${leg}
  `;
}
