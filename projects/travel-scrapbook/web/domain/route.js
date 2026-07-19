// domain/route.js — the trip's Google Maps directions links, used by the
// Download menu's "Open in Google Maps" row. Route ORDERING happens client-side
// in domain/route-plan.js and shows in the timeline itself.
'use strict';

const RouteDomain = {
  async mapsLinks(tripId, { date, itinerary } = {}) {
    return window.api.exportMapsLinks(tripId, { date, itinerary });
  },
};
window.RouteDomain = RouteDomain;
