// domain/collection.js — Collection mutations + cached viewer status map +
// per-base-game expansion-owned counts. Both maps come from a single
// /collection fetch and are cached together; any mutation busts both.

(function () {
  let _status = null;            // { gameId: 'owned' | 'wishlist' | 'played' }
  let _expCount = null;          // { base_game_bgg_id: count }
  let _inflight = null;

  async function _ensure({ force = false } = {}) {
    if (!force && _status && _expCount) return { status: _status, expCount: _expCount };
    if (_inflight) return _inflight;
    _inflight = (async () => {
      try {
        const data = await window.api.get("/collection");
        const items = Array.isArray(data) ? data : ((data && data.items) || []);
        const status = {};
        const expCount = {};
        for (const it of items) {
          if (it.status === "owned" || it.status === "wishlist" || it.status === "played") {
            status[it.game_id] = it.status;
          }
          // Count owned expansions per base BGG id so any tile rendered for
          // a base game can surface how many expansions the user has.
          const g = it.game;
          if (it.status === "owned" && g && g.is_expansion && g.base_game_bgg_id) {
            expCount[g.base_game_bgg_id] = (expCount[g.base_game_bgg_id] || 0) + 1;
          }
        }
        _status = status;
        _expCount = expCount;
        window.store.set("myCollectionMap", status);
        return { status, expCount };
      } finally {
        _inflight = null;
      }
    })();
    return _inflight;
  }

  class Collection {
    static add(gameId, status) {
      return window.api
        .post("/collection", { game_id: gameId, status })
        .then((r) => { Collection.invalidateMyStatusMap(); return r; });
    }

    static updateStatus(itemId, status) {
      return window.api.patch(`/collection/${itemId}`, { status })
        .then((r) => { Collection.invalidateMyStatusMap(); return r; });
    }

    static remove(itemId) {
      return window.api.del(`/collection/${itemId}`)
        .then((r) => { Collection.invalidateMyStatusMap(); return r; });
    }

    // Remove by game UUID — the path the status-tag picker uses to clear
    // a tile's status without needing the underlying collection row id.
    static removeByGame(gameId) {
      return window.api.del(`/collection/by-game/${gameId}`)
        .then((r) => { Collection.invalidateMyStatusMap(); return r; });
    }

    static async statusFor(gameId) {
      // Route through the cached map so we don't fire a per-page round-trip
      // (and avoid the now-removed /collection/status/{id} endpoint that
      // never made it onto the redesigned backend).
      const map = await Collection.myStatusMap();
      return (map && map[gameId]) || null;
    }

    static async myStatusMap(opts = {}) {
      const r = await _ensure(opts);
      return r.status;
    }

    static async myExpansionCountByBaseBggId(opts = {}) {
      const r = await _ensure(opts);
      return r.expCount;
    }

    static invalidateMyStatusMap() {
      _status = null;
      _expCount = null;
      window.store.invalidate("myCollectionMap");
    }
  }

  window.Collection = Collection;
})();
