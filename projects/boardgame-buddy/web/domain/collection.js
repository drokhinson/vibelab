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

  function _shelfKey(targetUserId, status, includeExpansions) {
    // The expansions dimension is part of the key because the two shapes are
    // a subset/superset pair over the same (target, status): without it the
    // tree's fetch would overwrite the flat Owned grid's entry with rows the
    // grid filters out anyway, and vice versa.
    return `${targetUserId || "me"}|${status}|${includeExpansions ? "all" : "base"}`;
  }

  /** Shared request builder — shelf() and cachedShelf() must not drift. */
  async function _fetchShelf(targetUserId, status, includeExpansions) {
    const qs = new URLSearchParams({
      status,
      exclude_expansions: includeExpansions ? "false" : "true",
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
  }

  async function _fetch() {
    // /collection/status-map is one bounded round trip. This used to read
    // GET /collection, which costs three UNBOUNDED ones — the whole collection
    // with a games join, play stats over the viewer's entire visible history
    // (which grows with their buddies' logging, not just their own), then an
    // IN-query to hydrate played-not-owned games — and then discarded
    // everything except the two dicts below. At a 60s fresh window that read
    // re-fired roughly once a minute of active navigation.
    let data;
    try {
      data = await window.api.get("/collection/status-map");
    } catch (e) {
      // Readers hide their status corner while the map is unknown (null). A
      // failed fetch has to end that wait, or an owned game shows no state at
      // all for the rest of the session — degrade to the "+" instead.
      if (window.store.get("myCollectionMap") == null) window.store.set("myCollectionMap", {});
      throw e;
    }
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
    ).then((r) => {
      // Publish on every resolve, cache hits included. _fetch only runs on a
      // miss or a background revalidate, so without this a warm cache left the
      // store's map null and every play card rendered as "status unknown"
      // until the next network read landed. store.set no-ops when the object
      // identity is unchanged, so a cache hit costs one comparison.
      if (r && r.status) window.store.set("myCollectionMap", r.status);
      return r;
    });
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

    /**
     * Optimistic status write, local half: patch the cached status map and
     * announce the change so every mounted surface repaints in the tap's own
     * frame. `null` means "no relationship" — listeners delete their entry and
     * the tile flips back to "+".
     *
     * Callers run this BEFORE the network write and again with the previous
     * value if that write fails. It is deliberately state-only: the error
     * surface belongs to the screen the user is looking at, not here.
     *
     * Three call sites had spelled this out by hand — the status sheet, the
     * add-game modal and the Add Games page — which is exactly the drift
     * .claude/rules/ui-object-design.md §4 says to extract at instance #2.
     *
     * @param {string} gameId
     * @param {("owned"|"wishlist"|"played"|null)} status
     */
    static applyLocalStatus(gameId, status) {
      if (!gameId) return;
      const cur = (window.store && window.store.get && window.store.get("myCollectionMap")) || {};
      const next = { ...cur };
      if (status == null) delete next[gameId];
      else next[gameId] = status;
      window.store.set("myCollectionMap", next);
      document.dispatchEvent(new CustomEvent("status-changed", {
        detail: { gameId, status: status == null ? null : status },
      }));
    }

    /**
     * Mark (or unmark) an owned game as played before the user joined, so a
     * pre-account favourite can leave the Shelf of Shame without a fabricated
     * play. Migration 059; opened from the Stats spoke's shelf sheet.
     *
     * Deliberately does NOT bust the status map: the mark is scoped to the
     * shelf block of bgb_user_stats_detail, and the game keeps reading as
     * Owned everywhere else. Busting that cache would imply otherwise.
     * views/stats-view.js invalidates the stats payload, which is the one
     * cache this does move.
     *
     * @param {string} gameId
     * @param {boolean} playedBefore
     */
    static setPlayedBefore(gameId, playedBefore) {
      return window.api.patch(`/collection/${gameId}/played-before`, {
        played_before: playedBefore,
      });
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

    /** Synchronous peek at the cached per-base-game owned-expansion counts. */
    static cachedExpansionCounts() {
      if (!window.bgbCache) return null;
      const entry = window.bgbCache.peek(NS, COMBINED_KEY);
      return (entry && entry.expCount) || null;
    }

    static async myExpansionCountByBaseBggId(opts = {}) {
      const r = await _ensure(opts);
      return r.expCount;
    }

    /**
     * A whole collection shelf, cached. Callers page, filter and search this
     * locally via window.ShelfFilter rather than re-fetching per page.
     *
     * `includeExpansions` asks the server for owned expansion rows too — the
     * Collection spoke's Expansions tree needs them, every other caller
     * filters them out. Grouping stays client-side (domain/expansion-tree.js)
     * because each row already carries is_expansion / base_game_bgg_id /
     * bgg_id, and nesting in SQL would silently drop owned expansions whose
     * base game the viewer doesn't own.
     *
     * @param {string} targetUserId
     * @param {"owned"|"wishlist"|"played"} status
     * @param {{force?: boolean, includeExpansions?: boolean}} [opts]
     * @returns {Promise<{items: any[], total: number, truncated: boolean}>}
     */
    static shelf(targetUserId, status, { force = false, includeExpansions = false } = {}) {
      const key = _shelfKey(targetUserId, status, includeExpansions);
      if (force) window.bgbCache.delete(SHELF_NS, key);
      return window.bgbCache.swr(
        SHELF_NS,
        key,
        () => _fetchShelf(targetUserId, status, includeExpansions),
        { freshTtl: SHELF_FRESH_TTL_MS, staleTtl: SHELF_STALE_TTL_MS },
      );
    }

    /**
     * Every catalog expansion for the base games this user owns, for the
     * Expansions tree's "show all" toggle. One request rather than a
     * /games/{id}/expansions call per base game.
     *
     * Cached in the shelf namespace so invalidateShelves() — which every
     * collection mutation already fans out to — covers it. A BGG *import*
     * does not go through that path (it changes the catalog, not anyone's
     * collection), so the import flow force-refreshes explicitly.
     *
     * @param {string} targetUserId
     * @param {{force?: boolean}} [opts]
     * @returns {Promise<any[]>}
     */
    static expansionCatalog(targetUserId, { force = false } = {}) {
      const key = `${targetUserId || "me"}|expcatalog`;
      if (force) window.bgbCache.delete(SHELF_NS, key);
      return window.bgbCache.swr(
        SHELF_NS,
        key,
        async () => {
          const qs = new URLSearchParams();
          const me = window.store.get("user");
          if (targetUserId && me && targetUserId !== me.id) {
            qs.set("user_id", targetUserId);
          }
          const q = qs.toString();
          const data = await window.api.get(`/collection/expansion-catalog${q ? "?" + q : ""}`);
          return (data && data.items) || [];
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
    static cachedShelf(targetUserId, status, { includeExpansions = false } = {}) {
      if (!window.bgbCache) return null;
      return window.bgbCache.peek(SHELF_NS, _shelfKey(targetUserId, status, includeExpansions));
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
