// widgets/export-menu.js — the trip Download popup: choose a scope (all days
// or one day) and a format (Markdown / CSV / KML) or open the route in Google
// Maps. Opened from the trip toolbar's download button. Each scope shows its
// mapped-pin count so the user knows what a file will contain; format rows
// gate on that count. Mirrors the PriorityPicker modal pattern.
'use strict';

const ExportMenu = {
  // days: [{ date, day_number, points }] (points = mapped pins that day).
  // allPoints = mapped pins across the whole trip.
  open({ tripId, tripName = 'trip', days = [], allPoints = 0 } = {}) {
    this.close();
    this._ctx = { tripId, tripName };
    // Scope options: "All days" first, then one per dated day. `value` is the
    // ISO date sent as ?date= (empty = whole trip); `suffix` names the file.
    this._scopes = [
      { value: '', label: 'All days', points: allPoints, suffix: '' },
      ...days.map((d) => ({
        value: d.date,
        label: `Day ${d.day_number} · ${typeof _tlDay === 'function' ? _tlDay(d.date) : d.date}`,
        points: d.points,
        suffix: `Day ${d.day_number}`,
      })),
    ];
    this._scope = this._scopes[0];

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'export-menu-modal';
    modal.innerHTML = `
      <div class="ts-modal__backdrop" onclick="ExportMenu.close()"></div>
      <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Download trip">
        <button class="ts-modal__close" onclick="ExportMenu.close()" aria-label="Close"><i data-lucide="x"></i></button>
        <h2 class="ts-modal__title">Download trip</h2>
        ${this._scopes.length > 1 ? `
          <label class="export-scope">
            <span class="export-scope__label">What to export</span>
            <select class="ts-select export-scope__select" id="export-scope" aria-label="What to export">
              ${this._scopes.map((s, i) => `
                <option value="${escapeAttr(s.value)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(s.label)} (${s.points} point${s.points === 1 ? '' : 's'})</option>`).join('')}
            </select>
          </label>` : ''}
        <div class="export-options" id="export-options">${this._rowsHtml()}</div>
        <div id="export-legs" class="export-legs"></div>
      </div>
    `;
    document.body.appendChild(modal);
    window.lucide?.createIcons({ root: modal });

    modal.querySelector('#export-scope')?.addEventListener('change', (e) => {
      this._scope = this._scopes.find((s) => s.value === e.target.value) || this._scopes[0];
      const host = modal.querySelector('#export-options');
      host.innerHTML = this._rowsHtml();
      this._bindRows(host);
      modal.querySelector('#export-legs').innerHTML = '';
      window.lucide?.createIcons({ root: host });
    });
    this._bindRows(modal.querySelector('#export-options'));
  },

  // The four format rows for the current scope. Gating keys off the scope's
  // mapped-pin count: Markdown always works; CSV/KML need ≥1 pin; directions
  // need ≥2. The count shown to the user is pins, so a greyed row reads true.
  _rowsHtml() {
    const points = this._scope.points;
    const rows = [
      { key: 'md', icon: 'file-text', label: 'Trip notes (.md)', sub: 'Readable itinerary with notes & map links', min: 0 },
      { key: 'csv', icon: 'table', label: 'Spreadsheet (.csv)', sub: 'Import into Google My Maps', min: 1 },
      { key: 'kml', icon: 'map-pin', label: 'Map points (.kml)', sub: 'Pins for Google My Maps / Google Earth', min: 1 },
      { key: 'maps', icon: 'map', label: 'Open in Google Maps', sub: 'Turn-by-turn directions links', min: 2 },
    ];
    return rows.map((r) => {
      const off = points < r.min;
      const hint = off
        ? (points === 0 ? 'No mapped pins here' : `Need ${r.min}+ pins${r.key === 'maps' ? ' for directions' : ''}`)
        : r.sub;
      return `
        <button class="export-option" data-key="${r.key}" ${off ? 'disabled' : ''}>
          <i data-lucide="${r.icon}" class="export-option__icon"></i>
          <span class="export-option__text">
            <span class="export-option__label">${escapeHtml(r.label)}</span>
            <span class="export-option__sub">${escapeHtml(hint)}</span>
          </span>
          <i data-lucide="download" class="export-option__go"></i>
        </button>`;
    }).join('');
  },

  _bindRows(host) {
    host.querySelectorAll('.export-option').forEach((btn) => {
      btn.addEventListener('click', () => this._pick(btn.dataset.key));
    });
  },

  async _pick(key) {
    const { tripId, tripName } = this._ctx;
    const { value: date, suffix } = this._scope;
    if (key === 'maps') return this._maps(tripId, date);
    const jobs = {
      md: ['downloadMarkdown', 'Markdown downloaded'],
      csv: ['downloadCsv', 'CSV downloaded — import it in Google My Maps'],
      kml: ['downloadKml', 'Map points (.kml) downloaded — import into Google My Maps'],
    };
    const [fn, msg] = jobs[key] || [];
    if (!fn) return;
    try {
      await window.ExportDomain[fn](tripId, tripName, { date: date || undefined, suffix: suffix || undefined });
      this.close();
      toast(msg);
    } catch (err) {
      toast(err.message || 'Download failed', { error: true });
    }
  },

  // Fetch the Google Maps directions legs for the current scope. One leg opens
  // straight away; several render as a link list inside the modal (≤10 stops).
  async _maps(tripId, date) {
    try {
      const res = await window.RouteDomain.mapsLinks(tripId, date);
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
