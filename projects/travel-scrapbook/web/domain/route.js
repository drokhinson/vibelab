// domain/route.js — the trip's external map exports (Google Maps directions
// links + CSV for Google My Maps), used by the Download menu. Route ORDERING now
// happens client-side in domain/route-plan.js and shows in the timeline itself;
// the backend POST /route/optimize endpoint stays for other clients, unused here.
'use strict';

const RouteDomain = {
  async mapsLinks(tripId, date) {
    return window.api.exportMapsLinks(tripId, date ? { date } : {});
  },

  // The download itself lives in ExportDomain so there's one code path for every
  // file export.
  async downloadCsv(tripId, tripName) {
    return window.ExportDomain.downloadCsv(tripId, tripName);
  },
};
window.RouteDomain = RouteDomain;
