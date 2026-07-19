// domain/trip.js — trip + anchor operations against the API, store-backed.
// Reads write through to tsCache (stale-while-revalidate on screen re-entry);
// the patch helpers let mutations update one card in the trip bundle without
// refetching the whole trip.
'use strict';

const TripDomain = {
  async loadAll() {
    const res = await window.api.listTrips();
    // A revalidate that changed nothing shouldn't re-emit (a full re-render
    // would replay entrance animations — the "blink"); just re-arm the TTL.
    window.tsCache?.set('trips', '', res.trips);
    if (JSON.stringify(res.trips) !== JSON.stringify(window.store.get('trips'))) {
      window.store.set('trips', res.trips);
    }
    return res.trips;
  },

  async load(tripId) {
    const trip = await window.api.getTrip(tripId);
    this._applyTrip(trip);
    return trip;
  },

  // One write path for a trip bundle: store (re-renders subscribers), cache,
  // and the members roster that rides on the bundle. Skips the store emission
  // when the bundle is byte-identical to what's already painted (no-blink
  // revalidate) — the cache TTL still refreshes.
  _applyTrip(trip) {
    window.tsCache?.set('trip', trip.id, trip);
    if (JSON.stringify(trip) === JSON.stringify(window.store.get('trip:' + trip.id))) return;
    window.store.set('trip:' + trip.id, trip);
    if (trip.members) window.store.set('members:' + trip.id, trip.members);
  },

  // Replace one scrap in the bundle with a membership-scoped card returned by
  // the API (assign/approve/schedule/vibe echoes). Handles staged→approved
  // moves by rebucketing on the card's status, and drops the place from the
  // candidates panel once it's on the trip.
  patchScrap(tripId, scrap) {
    const trip = window.store.get('trip:' + tripId);
    if (!trip) return;
    const swap = (list) => (list || []).map((s) => (s.id === scrap.id ? { ...s, ...scrap } : s));
    let all = [...swap(trip.scraps), ...swap(trip.staged_scraps)];
    if (!all.some((s) => s.id === scrap.id)) all = [scrap, ...all];
    this._applyTrip({
      ...trip,
      scraps: all.filter((s) => s.status === 'approved'),
      staged_scraps: all.filter((s) => s.status === 'staged'),
      candidates: (trip.candidates || []).filter((s) => s.id !== scrap.id),
    });
  },

  // Shallow-merge fields onto one scrap wherever it appears in the bundle.
  // For echoes WITHOUT membership context (rating / visited / notes edits) —
  // pass only the fields that changed so vibes/status/plan_date survive.
  patchScrapFields(tripId, scrapId, fields) {
    const trip = window.store.get('trip:' + tripId);
    if (!trip) return;
    const merge = (list) => (list || []).map((s) => (s.id === scrapId ? { ...s, ...fields } : s));
    this._applyTrip({
      ...trip,
      scraps: merge(trip.scraps),
      staged_scraps: merge(trip.staged_scraps),
      candidates: merge(trip.candidates),
    });
  },

  removeScrap(tripId, scrapId) {
    const trip = window.store.get('trip:' + tripId);
    if (!trip) return;
    const drop = (list) => (list || []).filter((s) => s.id !== scrapId);
    this._applyTrip({
      ...trip,
      scraps: drop(trip.scraps),
      staged_scraps: drop(trip.staged_scraps),
    });
  },

  async create(fields) {
    const trip = await window.api.createTrip(fields);
    await this.loadAll();
    return trip;
  },

  async update(tripId, fields) {
    await window.api.updateTrip(tripId, fields);
    window.tsCache?.invalidate('trips');
    return this.load(tripId);
  },

  async remove(tripId) {
    await window.api.deleteTrip(tripId);
    window.tsCache?.invalidate('trip', tripId);
    await this.loadAll();
  },

  async addAnchor(tripId, fields) {
    const anchor = await window.api.createAnchor(tripId, fields);
    await this.load(tripId);
    return anchor;
  },

  async updateAnchor(tripId, anchorId, fields) {
    const anchor = await window.api.updateAnchor(anchorId, fields);
    await this.load(tripId);
    return anchor;
  },

  async removeAnchor(tripId, anchorId) {
    await window.api.deleteAnchor(anchorId);
    await this.load(tripId);
  },

  // Endpoints (arrival/departure) — bookend plans (026). `which` is
  // 'arrival'|'departure'. Reload the bundle so the timeline bookends + plans
  // list reflect the flag/date change (mirrors the anchor ops above).
  async addEndpoint(tripId, fields) {
    const scrap = await window.api.createEndpoint(tripId, fields);
    await this.load(tripId);
    return scrap;
  },

  async updateEndpoint(tripId, which, fields) {
    const scrap = await window.api.updateEndpoint(tripId, which, fields);
    await this.load(tripId);
    return scrap;
  },

  async removeEndpoint(tripId, which) {
    await window.api.deleteEndpoint(tripId, which);
    await this.load(tripId);
  },
};
window.TripDomain = TripDomain;
