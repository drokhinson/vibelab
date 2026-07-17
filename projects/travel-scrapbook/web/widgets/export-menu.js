// widgets/export-menu.js — the trip Download popup: pick a format
// (Markdown / CSV / KML) or open the route in Google Maps. Opened from the
// trip toolbar's download button. Mirrors the PriorityPicker modal pattern.
'use strict';

const ExportMenu = {
  open({ tripId, tripName = 'trip', geocodedCount = 0 } = {}) {
    this.close();
    const hasPins = geocodedCount >= 2;
    // needsPins rows are greyed out until the trip has ≥2 mapped places,
    // matching the Route panel's gate. Markdown works with zero.
    const options = [
      { key: 'md', icon: 'file-text', label: 'Trip notes (.md)',
        sub: 'Readable itinerary with notes & map links', needsPins: false },
      { key: 'csv', icon: 'table', label: 'Spreadsheet (.csv)',
        sub: 'Import into Google My Maps', needsPins: true },
      { key: 'kml', icon: 'map-pin', label: 'Map points (.kml)',
        sub: 'Pins for Google My Maps / Google Earth', needsPins: true },
      { key: 'maps', icon: 'map', label: 'Open in Google Maps',
        sub: 'Turn-by-turn directions links', needsPins: true },
    ];

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'export-menu-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="ExportMenu.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Download trip">
        <button class="ts-modal__close" onclick="ExportMenu.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Download trip</h2>
        <div class="export-options" id="export-options">
          ${options.map((o) => {
            const off = o.needsPins && !hasPins;
            return `
              <button class="export-option" data-key="${o.key}" ${off ? 'disabled' : ''}>
                <i data-lucide="${o.icon}" class="export-option__icon"></i>
                <span class="export-option__text">
                  <span class="export-option__label">${escapeHtml(o.label)}</span>
                  <span class="export-option__sub">${off ? 'Pin at least 2 places first' : escapeHtml(o.sub)}</span>
                </span>
                <i data-lucide="download" class="export-option__go"></i>
              </button>`;
          }).join('')}
        </div>
        <div id="export-legs" class="export-legs"></div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });
    modal.querySelectorAll('.export-option').forEach((btn) => {
      btn.addEventListener('click', () => this._pick(btn.dataset.key, tripId, tripName));
    });
  },

  async _pick(key, tripId, tripName) {
    if (key === 'maps') return this._maps(tripId);
    const jobs = {
      md: ['downloadMarkdown', 'Markdown downloaded'],
      csv: ['downloadCsv', 'CSV downloaded — import it in Google My Maps'],
      kml: ['downloadKml', 'Map points (.kml) downloaded — import into Google My Maps'],
    };
    const [fn, msg] = jobs[key] || [];
    if (!fn) return;
    try {
      await window.ExportDomain[fn](tripId, tripName);
      this.close();
      toast(msg);
    } catch (err) {
      toast(err.message || 'Download failed', { error: true });
    }
  },

  // Fetch the Google Maps directions legs. One leg opens straight away;
  // several render as a link list inside the modal (each ≤10 stops).
  async _maps(tripId) {
    try {
      const res = await window.RouteDomain.mapsLinks(tripId);
      if (!res.legs.length) { toast('Pin at least two places first', { error: true }); return; }
      if (res.legs.length === 1) {
        window.open(res.legs[0].url, '_blank', 'noopener');
        this.close();
        return;
      }
      const legsEl = document.getElementById('export-legs');
      if (!legsEl) return;
      legsEl.innerHTML = res.legs.map((leg) => `
        <a class="ts-btn ts-btn--ghost ts-btn--sm" href="${escapeAttr(leg.url)}" target="_blank" rel="noopener" style="justify-content:flex-start;">
          <i data-lucide="external-link"></i>${escapeHtml(leg.label)} (${leg.stop_count} stops)
        </a>`).join('');
      window.lucide?.createIcons({ root: legsEl });
    } catch (err) {
      toast(err.message || 'Could not build map links', { error: true });
    }
  },

  close() {
    document.getElementById('export-menu-modal')?.remove();
  },
};
window.ExportMenu = ExportMenu;
