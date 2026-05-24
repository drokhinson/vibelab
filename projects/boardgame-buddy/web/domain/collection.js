// domain/collection.js — Collection mutations + cached viewer status map +
// per-base-game expansion-owned counts. Both maps come from a single
// /collection fetch and are cached together; any mutation busts both.
//
// SWR-backed: the bootstrap loader seeds this namespace on auth, so the
// first Profile / Feed / Game Detail render after sign-in pays zero round
// trips for status pills. Stale entries serve immediately and refresh in
// the background.

(function () {
  const NS = "collection";
  const COMBINED_KEY = "combined";
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 5 * 60 * 1000;

  async function _fetch() {
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
    window.store.set("myCollectionMap", status);
    return { status, expCount };
  }

  function _ensure({ force = false } = {}) {
    if (force) window.bgbCache.delete(NS, COMBINED_KEY);
    return window.bgbCache.swr(
      NS,
      COMBINED_KEY,
      _fetch,
      { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
    );
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
      window.bgbCache.delete(NS, COMBINED_KEY);
      window.store.invalidate("myCollectionMap");
      // The Profile bundle embeds the status map + every shelf's count — any
      // collection mutation invalidates both numbers, so clear the bundle
      // cache too. Game.detailBundle caches viewer_status alongside the game
      // row; clear that as well so a tile's pill in Game Detail tracks the
      // mutation a router-back lands on.
      if (window.Profile && window.Profile.invalidate) window.Profile.invalidate();
      if (window.Game && window.Game.invalidateBundle) window.Game.invalidateBundle();
    }

    /**
     * Prime the in-memory cache from the Profile bundle so views that get the
     * status map for free as part of the bundle don't pay a separate
     * /collection round trip. Both maps must be present and trusted to be
     * complete — passing partial data here would mask later writes since the
     * cache treats this as a normal hydration.
     */
    static seedFromBundle(statusMap, expansionCounts) {
      if (!statusMap || !expansionCounts) return;
      const status = { ...statusMap };
      const expCount = { ...expansionCounts };
      window.bgbCache.setWithTtls(
        NS,
        COMBINED_KEY,
        { status, expCount },
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
      window.store.set("myCollectionMap", status);
    }
  }

  window.Collection = Collection;
})();
