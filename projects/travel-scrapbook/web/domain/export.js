// domain/export.js — trip file downloads (Markdown / CSV / KML).
// Canonical home for "save this trip as a file" — every export blob flows
// through _saveBlob so the download mechanics live in exactly one place.
'use strict';

const ExportDomain = {
  // Fetch a blob, then hand the browser a temp <a download> to save it.
  async _saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },

  // Filename stem: sanitized trip name, plus a " - Day N" suffix on a
  // single-day export so the four files never collide in the download folder.
  _stem(name, suffix) {
    const base = (name || 'trip').replace(/[^\w\- ]+/g, '').trim() || 'trip';
    return suffix ? `${base} - ${suffix}` : base;
  },

  // A single day passes ?date=YYYY-MM-DD; `itinerary` (the client's computed
  // order) is POSTed so auto-placed stops land in the file in the right day/order.
  async downloadCsv(tripId, tripName, { date, suffix, itinerary } = {}) {
    await this._saveBlob(await window.api.exportCsv(tripId, { date, itinerary }), `${this._stem(tripName, suffix)}.csv`);
  },

  async downloadMarkdown(tripId, tripName, { date, suffix, itinerary } = {}) {
    await this._saveBlob(await window.api.exportMarkdown(tripId, { date, itinerary }), `${this._stem(tripName, suffix)}.md`);
  },

  async downloadKml(tripId, tripName, { date, suffix, itinerary } = {}) {
    await this._saveBlob(await window.api.exportKml(tripId, { date, itinerary }), `${this._stem(tripName, suffix)}.kml`);
  },

  // Import-audit flowchart: the backend renders the stored parse trace to a
  // self-contained HTML file (link → expansion → fetch → AI → geocode → …).
  async downloadImportAudit(sourceId, label) {
    await this._saveBlob(await window.api.importAudit(sourceId), `${this._stem(label || 'import', 'audit')}.html`);
  },
};
window.ExportDomain = ExportDomain;
