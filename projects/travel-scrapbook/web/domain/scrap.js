// domain/scrap.js — scrap operations + the pending-enrichment poll loop.
'use strict';

const ScrapDomain = {
  _pollTimer: null,
  _pollTripId: null,
  _pollStartedAt: 0,
  POLL_INTERVAL_MS: 2000,
  POLL_TIMEOUT_MS: 45000,

  async create(tripId, url, notes) {
    const scrap = await window.api.createScrap({ trip_id: tripId, url, notes: notes || null });
    this.startPolling(tripId);
    return scrap;
  },

  async update(scrapId, tripId, fields) {
    const scrap = await window.api.updateScrap(scrapId, fields);
    if (tripId) await window.TripDomain.load(tripId);
    return scrap;
  },

  async retry(scrapId, tripId) {
    await window.api.retryScrap(scrapId);
    if (tripId) {
      await window.TripDomain.load(tripId);
      this.startPolling(tripId);
    }
  },

  async remove(scrapId, tripId) {
    await window.api.deleteScrap(scrapId);
    if (tripId) await window.TripDomain.load(tripId);
  },

  // Poll the trip while any scrap is pending. A monotonic trip guard stops a
  // stale loop from clobbering another trip's state after navigation.
  startPolling(tripId) {
    this.stopPolling();
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
      // Timed out — mark still-pending scraps as stuck so the UI offers retry.
      window.store.set('pollTimedOut:' + tripId, true);
      this.stopPolling();
      return;
    }
    try {
      const trip = await window.api.getTrip(tripId);
      if (this._pollTripId !== tripId) return; // navigated away mid-fetch
      window.store.set('trip:' + tripId, trip);
      const stillPending = (trip.scraps || []).some((s) => s.status === 'pending');
      if (!stillPending) this.stopPolling();
    } catch (err) {
      console.warn('[travel-scrapbook] poll failed:', err);
    }
  },
};
window.ScrapDomain = ScrapDomain;
