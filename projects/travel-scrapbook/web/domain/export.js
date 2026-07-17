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

  _stem(name) {
    return (name || 'trip').replace(/[^\w\- ]+/g, '').trim() || 'trip';
  },

  async downloadCsv(tripId, tripName) {
    await this._saveBlob(await window.api.exportCsv(tripId), `${this._stem(tripName)}.csv`);
  },

  async downloadMarkdown(tripId, tripName) {
    await this._saveBlob(await window.api.exportMarkdown(tripId), `${this._stem(tripName)}.md`);
  },

  async downloadKml(tripId, tripName) {
    await this._saveBlob(await window.api.exportKml(tripId), `${this._stem(tripName)}.kml`);
  },
};
window.ExportDomain = ExportDomain;
