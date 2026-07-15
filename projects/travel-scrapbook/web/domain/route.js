// domain/route.js — route optimization + exports.
'use strict';

const RouteDomain = {
  async optimize(tripId, opts) {
    const result = await window.api.optimizeRoute(tripId, opts || {});
    window.store.set('route:' + tripId, result);
    return result;
  },

  async mapsLinks(tripId) {
    return window.api.exportMapsLinks(tripId);
  },

  async downloadCsv(tripId, tripName) {
    const blob = await window.api.exportCsv(tripId);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(tripName || 'trip').replace(/[^\w\- ]+/g, '').trim() || 'trip'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
};
window.RouteDomain = RouteDomain;
