// domain/scrap.js — scrap operations + the post-capture trip poll loop.
// Mutations patch the affected card into the trip bundle (via TripDomain's
// patch helpers) instead of refetching the whole trip; vibe/rating taps
// paint optimistically and roll back on error.
'use strict';

(function () {
  // Consensus roll-up, mirroring services/hydrate.py (_VIBE_ORDER tie-break:
  // most-committed wins when two levels tie on count).
  const VIBE_ORDER = ['booked', 'must_do', 'interested', 'could_skip'];
  const VIBE_LABEL = { booked: 'Booked', must_do: 'Must do', interested: 'Interested', could_skip: 'Could skip' };

  function computeConsensus(vibes) {
    const counts = {};
    for (const v of vibes) counts[v.level] = (counts[v.level] || 0) + 1;
    const total = vibes.length;
    if (!total) return { counts: {}, total: 0, headline: 'No vibes yet' };
    let top = VIBE_ORDER[0];
    for (const lv of VIBE_ORDER) if ((counts[lv] || 0) > (counts[top] || 0)) top = lv;
    const label = VIBE_LABEL[top];
    return { counts, total, headline: total === 1 ? label : `${label} · ${counts[top]} of ${total}` };
  }

  // The scrap-owned fields of an API echo that lack membership context
  // (PATCH /scraps, rating endpoints return the Wander-List shape — merging
  // them whole would wipe the card's status/plan/vibes).
  function ownFields(scrap) {
    const keys = ['place_name', 'place_city', 'place_region', 'place_country',
      'category', 'lat', 'lng', 'geocode_confidence', 'geocode_display_name',
      'maps_url', 'og_image_url', 'sources', 'notes', 'rating', 'visited_at',
      'updated_at'];
    const out = {};
    for (const k of keys) if (k in scrap) out[k] = scrap[k];
    return out;
  }

  const ScrapDomain = {
    _pollTimer: null,
    _pollTripId: null,
    _pollStartedAt: 0,
    _pollBaseline: 0,
    POLL_INTERVAL_MS: 2000,
    POLL_TIMEOUT_MS: 45000,

    // Wander List / Visited pages cache their filtered pages — drop them
    // whenever a mutation changes what those lists would show.
    _invalidateLists() {
      window.tsCache?.invalidate('inbox');
      window.tsCache?.invalidate('visited');
    },

    // Capture a URL into a trip (quick-paste). Processing is server-side and
    // async — one URL can fan out into several scraps — so we poll the trip
    // until new scraps land or the timeout passes.
    async capture(tripId, url, notes) {
      const source = await window.api.capture({
        url, trip_id: tripId, via: 'paste', notes: notes || null,
      });
      this.startPolling(tripId);
      this._invalidateLists();
      window.SourceDomain?.refreshInboxCount();
      return source;
    },

    async update(scrapId, tripId, fields) {
      const scrap = await window.api.updateScrap(scrapId, fields);
      if (tripId) window.TripDomain.patchScrapFields(tripId, scrapId, ownFields(scrap));
      this._invalidateLists();
      return scrap;
    },

    async remove(scrapId, tripId) {
      await window.api.deleteScrap(scrapId);
      if (tripId) window.TripDomain.removeScrap(tripId, scrapId);
      this._invalidateLists();
    },

    // Mark a place visited / un-visited. Visited places leave the wishlist and
    // surface in the Visited view. Callers reload their own list after; we
    // patch the trip card (if any) and refresh the wishlist badge here.
    async toggleVisited(scrapId, tripId, currentlyVisited) {
      const scrap = await window.api.updateScrap(scrapId, { visited: !currentlyVisited });
      if (tripId) window.TripDomain.patchScrapFields(tripId, scrapId, { visited_at: scrap.visited_at });
      this._invalidateLists();
      window.SourceDomain?.refreshInboxCount();
    },

    async approve(scrapId, tripId) {
      const scrap = await window.api.approveScrap(scrapId, tripId);
      if (tripId) window.TripDomain.patchScrap(tripId, scrap);
    },

    async approveAll(tripId) {
      // The response is the trip's full plan list — rebucket it locally.
      const res = await window.api.approveAllStaged(tripId);
      const trip = window.store.get('trip:' + tripId);
      if (trip && res.scraps) {
        window.TripDomain._applyTrip({
          ...trip,
          scraps: res.scraps.filter((s) => s.status === 'approved'),
          staged_scraps: res.scraps.filter((s) => s.status === 'staged'),
        });
      } else {
        await window.TripDomain.load(tripId);
      }
    },

    // Set/clear a plan's per-trip timeline slot (day + optional time). The
    // echo carries the membership card; the Timeline tab recomputes locally.
    async schedule(scrapId, tripId, fields) {
      const scrap = await window.api.scheduleScrap(scrapId, tripId, fields);
      if (tripId) window.TripDomain.patchScrap(tripId, scrap);
    },

    // Paint my vibe/rating + recomputed consensus into the trip bundle BEFORE
    // the request so the tap feels instant. Returns the pre-mutation trip for
    // rollback (null when there's nothing local to paint).
    _optimisticVibe(tripId, scrapId, level, { withRating = false } = {}) {
      const user = window.store.get('user');
      const trip = tripId && window.store.get('trip:' + tripId);
      if (!user || !trip) return null;
      const upd = (s) => {
        if (s.id !== scrapId) return s;
        let vibes = (s.vibes || []).filter((v) => v.user_id !== user.user_id);
        if (level) vibes = [...vibes, { user_id: user.user_id, display_name: user.display_name, level }];
        const next = { ...s, vibes, consensus: computeConsensus(vibes) };
        if (withRating) next.rating = level || null;
        return next;
      };
      window.TripDomain._applyTrip({
        ...trip,
        scraps: (trip.scraps || []).map(upd),
        staged_scraps: (trip.staged_scraps || []).map(upd),
      });
      return trip;
    },

    // Set (level) or clear (null) my vibe on a place FOR ONE TRIP — explicit
    // target state from the PriorityPicker popup. Optimistic; the server's
    // card reconciles the consensus. Vibes are per (place, trip).
    async applyVibe(scrapId, tripId, level) {
      const snapshot = this._optimisticVibe(tripId, scrapId, level);
      try {
        const scrap = level
          ? await window.api.setVibe(scrapId, tripId, level)
          : await window.api.clearVibe(scrapId, tripId);
        if (tripId) window.TripDomain.patchScrap(tripId, scrap);
      } catch (err) {
        if (snapshot) window.TripDomain._applyTrip(snapshot);
        throw err;
      }
    },

    // Set/clear the owner's own rating on a place. On in-trip scraps the server
    // also syncs the owner's vibe row on EVERY trip the place is in, so the
    // optimistic paint (rating + my vibe) matches what the server persists.
    async applyRating(scrapId, tripId, level) {
      const snapshot = this._optimisticVibe(tripId, scrapId, level, { withRating: true });
      try {
        const scrap = level
          ? await window.api.setRating(scrapId, level)
          : await window.api.clearRating(scrapId);
        if (tripId) window.TripDomain.patchScrapFields(tripId, scrapId, { rating: scrap.rating });
        this._invalidateLists(); // rating chips show on the Wander List too
      } catch (err) {
        if (snapshot) window.TripDomain._applyTrip(snapshot);
        throw err;
      }
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
        if (tripId) window.TripDomain.patchScrapFields(tripId, scrapId, { visited_at: null });
        this._invalidateLists();
        window.SourceDomain?.refreshInboxCount();
      }
      await this.applyRating(scrapId, tripId, level);
    },

    // Staging "remove" / pulling a place out of ONE trip. The place stays on
    // the Wander List and in any other trips. The card drops instantly; a
    // background bundle refresh reconciles the candidates panel (the place
    // may qualify as a suggestion again).
    async unassign(scrapId, tripId) {
      await window.api.unassignScrap(scrapId, tripId);
      if (tripId) {
        window.TripDomain.removeScrap(tripId, scrapId);
        window.TripDomain.load(tripId).catch(() => {});
      }
      this._invalidateLists(); // trip_ids on Wander List cards changed
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
        window.TripDomain._applyTrip(trip);
        const count = this._tripItemCount(trip);
        if (count > this._pollBaseline) {
          this.stopPolling();
          this._invalidateLists();
          window.SourceDomain?.refreshInboxCount();
        }
      } catch (err) {
        console.warn('[travel-scrapbook] poll failed:', err);
      }
    },
  };
  window.ScrapDomain = ScrapDomain;
})();
