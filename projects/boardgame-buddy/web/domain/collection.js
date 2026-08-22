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

  // Whole-shelf cache, one entry per (target, status). Separate namespace from
  // the status map above so the two invalidate independently and so
  // bgbCache.clear() can drop every shelf at once after a mutation.
  //
  // The viewer is NOT part of the key — bindUser() already scopes localStorage
  // per signed-in user. The target IS, so bouncing between two people's
  // collections is free on the second visit.
  //
  // No search/filter dimension by design: the whole point is one entry per
  // shelf, with every page, filter and search derived from it client-side.
  const SHELF_NS = "collection.shelf";
  const SHELF_FRESH_TTL_MS = 60 * 1000;
  const SHELF_STALE_TTL_MS = 5 * 60 * 1000;
  // Matches _SHELF_DEFAULT_LIMIT on the endpoint. A shelf past this comes back
  // truncated and the caller falls back to the paginated grid.
  const SHELF_LIMIT = 1000;

  function _shelfKey(targetUserId, status) {
    return `${targetUserId || "me"}|${status}`;
  }

  async function _fetch() {
    // /collection/status-map is one bounded round trip. This used to read
    // GET /collection, which costs three UNBOUNDED ones — the whole collection
    // with a games join, play stats over the viewer's entire visible history
    // (which grows with their buddies' logging, not just their own), then an
    // IN-query to hydrate played-not-owned games — and then discarded
    // everything except the two dicts below. At a 60s fresh window that read
    // re-fired roughly once a minute of active navigation.
    const data = await window.api.get("/collection/status-map");
    const status = (data && data.status_map) || {};
    const expCount = (data && data.expansion_counts) || {};
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

    // Remove by game UUID — the path the status-tag picker uses to clear
    // a tile's status. DELETE /collection/{game_id} already keys on
    // (user_id, game_id), so the game UUID is all the backend needs.
    static removeByGame(gameId) {
      return window.api.del(`/collection/${gameId}`)
        .then((r) => { Collection.invalidateMyStatusMap(); return r; });
    }

    static async myStatusMap(opts = {}) {
      const r = await _ensure(opts);
      return r.status;
    }

    /**
     * Synchronous peek at the cached status map (or null). Lets a view paint
     * its status pills on the first frame instead of awaiting /collection —
     * the store slot normally wins, this covers a store reset with a warm
     * cache. Stale-tolerant on purpose: a pill that's a few minutes old beats
     * a blank screen, and myStatusMap() is what corrects it.
     */
    static cachedStatusMap() {
      if (!window.bgbCache) return null;
      const entry = window.bgbCache.peek(NS, COMBINED_KEY);
      return (entry && entry.status) || null;
    }

    static async myExpansionCountByBaseBggId(opts = {}) {
      const r = await _ensure(opts);
      return r.expCount;
    }

    /**
     * A whole collection shelf, cached. Callers page, filter and search this
     * locally via window.ShelfFilter rather than re-fetching per page.
     *
     * @param {string} targetUserId
     * @param {"owned"|"wishlist"|"played"} status
     * @param {{force?: boolean}} [opts]
     * @returns {Promise<{items: any[], total: number, truncated: boolean}>}
     */
    static shelf(targetUserId, status, { force = false } = {}) {
      const key = _shelfKey(targetUserId, status);
      if (force) window.bgbCache.delete(SHELF_NS, key);
      return window.bgbCache.swr(
        SHELF_NS,
        key,
        async () => {
          const qs = new URLSearchParams({
            status,
            exclude_expansions: "true",
            limit: String(SHELF_LIMIT),
          });
          const me = window.store.get("user");
          if (targetUserId && me && targetUserId !== me.id) {
            qs.set("user_id", targetUserId);
          }
          const data = await window.api.get(`/collection/shelf?${qs.toString()}`);
          return {
            items: (data && data.items) || [],
            total: (data && data.total) || 0,
            truncated: !!(data && data.truncated),
          };
        },
        { freshTtl: SHELF_FRESH_TTL_MS, staleTtl: SHELF_STALE_TTL_MS },
      );
    }

    /**
     * Synchronous stale-tolerant peek at a cached shelf, so a view can paint
     * page 1 in its first frame instead of awaiting the network. peek(), not
     * get(): a shelf a couple of minutes old beats a spinner, and shelf() is
     * what corrects it. Returns null on a miss.
     */
    static cachedShelf(targetUserId, status) {
      if (!window.bgbCache) return null;
      return window.bgbCache.peek(SHELF_NS, _shelfKey(targetUserId, status));
    }

    /**
     * Drop every cached shelf. Deliberately namespace-wide rather than
     * per-key: an add lands on owned OR wishlist, a status change moves a game
     * BETWEEN shelves, and removing an owned game can make it reappear on the
     * played shelf — so no single key covers a mutation. clear() also cancels
     * in-flight fetches in the namespace, so a request issued before the
     * mutation can't write itself back in.
     */
    static invalidateShelves() {
      if (window.bgbCache) window.bgbCache.clear(SHELF_NS);
    }

    static invalidateMyStatusMap() {
      window.bgbCache.delete(NS, COMBINED_KEY);
      window.store.invalidate("myCollectionMap");
      // Every cached shelf embeds the rows this mutation just changed.
      Collection.invalidateShelves();
      // The Profile bundle embeds the status map + every shelf's count — any
      // collection mutation invalidates both numbers, so clear the bundle
      // cache too. Game.detailBundle caches viewer_status alongside the game
      // row; clear that as well so a tile's pill in Game Detail tracks the
      // mutation a router-back lands on.
      if (window.Profile && window.Profile.invalidate) window.Profile.invalidate();
      if (window.Game && window.Game.invalidateBundle) window.Game.invalidateBundle();
      // Cached game searches embed each hit's collection_status — a mutation
      // changes which shelf a game sits on, so drop them too.
      if (window.Game && window.Game.invalidateSearch) window.Game.invalidateSearch();
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
