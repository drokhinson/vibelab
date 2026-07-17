// domain/route.js — route optimization + exports.
'use strict';

const RouteDomain = {
  async optimize(tripId, opts) {
    const result = await window.api.optimizeRoute(tripId, opts || {});
    window.store.set('route:' + tripId, result);
    return result;
  },

  async mapsLinks(tripId, date) {
    return window.api.exportMapsLinks(tripId, date ? { date } : {});
  },

  // Kept for the Route panel's CSV button; the download itself lives in
  // ExportDomain so there's one code path for every file export.
  async downloadCsv(tripId, tripName) {
    return window.ExportDomain.downloadCsv(tripId, tripName);
  },
};
window.RouteDomain = RouteDomain;
