// domain/scrap.js — scrap operations + the post-capture trip poll loop.
'use strict';

const ScrapDomain = {
  _pollTimer: null,
  _pollTripId: null,
  _pollStartedAt: 0,
  _pollBaseline: 0,
  POLL_INTERVAL_MS: 2000,
  POLL_TIMEOUT_MS: 45000,

  // Capture a URL into a trip (quick-paste). Processing is server-side and
  // async — one URL can fan out into several scraps — so we poll the trip
  // until new scraps land or the timeout passes.
  async capture(tripId, url, notes) {
    const source = await window.api.capture({
      url, trip_id: tripId, via: 'paste', notes: notes || null,
    });
    this.startPolling(tripId);
    window.SourceDomain?.refreshInboxCount();
    return source;
  },

  async update(scrapId, tripId, fields) {
    const scrap = await window.api.updateScrap(scrapId, fields);
    if (tripId) await window.TripDomain.load(tripId);
    return scrap;
  },

  async remove(scrapId, tripId) {
    await window.api.deleteScrap(scrapId);
    if (tripId) await window.TripDomain.load(tripId);
  },

  // Mark a place visited / un-visited. Visited places leave the wishlist and
  // surface in the Visited view. Callers reload their own list after; we reload
  // the trip (if any) and refresh the wishlist badge here.
  async toggleVisited(scrapId, tripId, currentlyVisited) {
    await window.api.updateScrap(scrapId, { visited: !currentlyVisited });
    if (tripId) await window.TripDomain.load(tripId);
    window.SourceDomain?.refreshInboxCount();
  },

  async approve(scrapId, tripId) {
    await window.api.approveScrap(scrapId);
    if (tripId) await window.TripDomain.load(tripId);
  },

  async approveAll(tripId) {
    await window.api.approveAllStaged(tripId);
    await window.TripDomain.load(tripId);
  },

  // Staging "remove" / pulling a scrap out of a trip — it returns to the inbox.
  async unassign(scrapId, tripId) {
    await window.api.unassignScrap(scrapId);
    if (tripId) await window.TripDomain.load(tripId);
    window.SourceDomain?.refreshInboxCount();
  },

  // Poll the trip while a capture is processing. A monotonic trip guard stops
  // a stale loop from clobbering another trip's state after navigation.
  startPolling(tripId) {
    this.stopPolling();
    const trip = window.store.get('trip:' + tripId);
    this._pollBaseline = trip
      ? (trip.scraps || []).length + (trip.staged_scraps || []).length
      : 0;
    this._pollTripId = tripId;
    this._pollStartedAt = Date.now();
    this._pollTimer = setInterval(() => this._tick(tripId), this.POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    this._pollTripId = null;
  },

  async _tick(tripId) {
    if (this._pollTripId !== tripId) return;
    if (Date.now() - this._pollStartedAt > this.POLL_TIMEOUT_MS) {
      // Timed out — the capture may have failed (it'll show in the inbox) or
      // the page is just slow. Either way, stop hammering.
      window.store.set('pollTimedOut:' + tripId, true);
      this.stopPolling();
      window.SourceDomain?.refreshInboxCount();
      return;
    }
    try {
      const trip = await window.api.getTrip(tripId);
      if (this._pollTripId !== tripId) return; // navigated away mid-fetch
      window.store.set('trip:' + tripId, trip);
      const count = (trip.scraps || []).length + (trip.staged_scraps || []).length;
      if (count > this._pollBaseline) {
        this.stopPolling();
        window.SourceDomain?.refreshInboxCount();
      }
    } catch (err) {
      console.warn('[travel-scrapbook] poll failed:', err);
    }
  },
};
window.ScrapDomain = ScrapDomain;
