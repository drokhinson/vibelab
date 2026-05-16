// domain/collection.js — Collection mutations (owned / wishlist toggles).
// Reads still happen through the legacy /collection endpoint until the
// closet/grid views are also rewritten — for now this only handles the
// per-card "Add to shelf" cycle that game-detail-view and the unified search
// hit.

(function () {
  class Collection {
    static add(gameId, status) {
      return window.api.post("/collection", { game_id: gameId, status });
    }

    static updateStatus(itemId, status) {
      return window.api.patch(`/collection/${itemId}`, { status });
    }

    static remove(itemId) {
      return window.api.del(`/collection/${itemId}`);
    }

    // Per-game status lookup for the bookmark cycle. Returns the current
    // status string ('owned' | 'wishlist') or null. The endpoint already
    // exists; this is just a typed wrapper.
    static async statusFor(gameId) {
      try {
        const data = await window.api.get(`/collection/status/${gameId}`);
        return data && data.status ? data.status : null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    }
  }

  window.Collection = Collection;
})();
