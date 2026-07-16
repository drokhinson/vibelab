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
    await window.api.approveScrap(scrapId, tripId);
    if (tripId) await window.TripDomain.load(tripId);
  },

  async approveAll(tripId) {
    await window.api.approveAllStaged(tripId);
    await window.TripDomain.load(tripId);
  },

  // Set/clear a plan's per-trip timeline slot (day + optional time).
  async schedule(scrapId, tripId, fields) {
    await window.api.scheduleScrap(scrapId, tripId, fields);
    if (tripId) await window.TripDomain.load(tripId);
  },

  // Set (level) or clear (null) my vibe on a place FOR ONE TRIP — explicit
  // target state from the PriorityPicker popup. Reloads the trip for fresh
  // consensus. Vibes are per (place, trip), so tripId is required.
  async applyVibe(scrapId, tripId, level) {
    if (level) await window.api.setVibe(scrapId, tripId, level);
    else await window.api.clearVibe(scrapId, tripId);
    if (tripId) await window.TripDomain.load(tripId);
  },

  // Set/clear the owner's own rating on a place. On in-trip scraps the server
  // also syncs the owner's vibe row, so we reload the trip for fresh consensus.
  async applyRating(scrapId, tripId, level) {
    if (level) await window.api.setRating(scrapId, level);
    else await window.api.clearRating(scrapId);
    if (tripId) await window.TripDomain.load(tripId);
  },

  // One entry point for the priority picker, where "Visited" is a level like
  // any other: 'visited' marks the place visited; a rating (or Clear) on a
  // visited place moves it back to the wishlist first, then applies.
  async applyPriority(scrapId, tripId, level, currentlyVisited) {
    if (level === 'visited') {
      if (!currentlyVisited) await this.toggleVisited(scrapId, tripId, false);
      return;
    }
    if (currentlyVisited) {
      await window.api.updateScrap(scrapId, { visited: false });
      window.SourceDomain?.refreshInboxCount();
    }
    await this.applyRating(scrapId, tripId, level);
  },

  // Staging "remove" / pulling a place out of ONE trip. The place stays on the
  // Wander List and in any other trips.
  async unassign(scrapId, tripId) {
    await window.api.unassignScrap(scrapId, tripId);
    if (tripId) await window.TripDomain.load(tripId);
    window.SourceDomain?.refreshInboxCount();
  },

  // Poll the trip while a capture is processing. A monotonic trip guard stops
  // a stale loop from clobbering another trip's state after navigation.
  // Scraps AND anchors count toward the baseline — a booking link lands as a
  // checkpoint (anchor), not a scrap, and should stop the poll too.
  _tripItemCount(trip) {
    return (trip.scraps || []).length + (trip.staged_scraps || []).length +
      (trip.anchors || []).length;
  },

  startPolling(tripId) {
    this.stopPolling();
    const trip = window.store.get('trip:' + tripId);
    this._pollBaseline = trip ? this._tripItemCount(trip) : 0;
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
      const count = this._tripItemCount(trip);
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
