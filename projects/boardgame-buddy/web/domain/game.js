// domain/game.js — Game catalog object.
// Hydrated from GameSummary / GameDetail backend shapes.

(function () {
  class Game {
    constructor(raw) {
      Object.assign(this, raw || {});
    }

    /**
     * Single-call Game Detail bundle. Returns the raw JSON from
     * /games/{id}/bundle: { game, base_game, viewer_status, recent_plays,
     * expansions, expansion_count_for_viewer }. Pre-warmed for every owned
     * game by the bootstrap loader; opened games are SWR-refreshed after the
     * 30-minute fresh window.
     */
    static async detailBundle(id, { force = false, playsLimit = 5 } = {}) {
      const cacheNs = "game.bundle";
      if (force) window.bgbCache.delete(cacheNs, id);
      return window.bgbCache.swr(
        cacheNs,
        id,
        () => window.api.get(`/games/${id}/bundle?plays_limit=${playsLimit}`),
        { freshTtl: 30 * 60 * 1000, staleTtl: 60 * 60 * 1000 },
      );
    }

    /** Invalidate the detailBundle cache for one id, or all when omitted. */
    static invalidateBundle(id) {
      if (id == null) window.bgbCache.clear("game.bundle");
      else window.bgbCache.delete("game.bundle", id);
    }

    // Cache key for a library search — normalized query + limit.
    static _searchKey(q, limit) {
      return `${(q || "").trim().toLowerCase()}|${limit}`;
    }

    // Synchronous peek at the cached library-search result (or null). The
    // GameFinder uses this to render instantly on backspace/re-type and to
    // decide whether it needs to show a loading state at all.
    static cachedSearch(q, { limit = 20 } = {}) {
      if (!window.bgbCache) return null;
      return window.bgbCache.get("game.search", Game._searchKey(q, limit));
    }

    // Single ranked search. include_bgg=true appends BGG hits.
    //
    // Library searches (include_bgg=false) are memoized in bgbCache under
    // "game.search" so re-typing a query the user already searched is instant
    // and doesn't re-hit the DB. Invalidated by Game.invalidateSearch() after
    // any collection mutation so a freshly-added game's status stays correct.
    // BGG searches bypass the cache — they hit the external BGG API (already
    // cached server-side) and are far less frequent.
    static async search(q, { includeBgg = false, limit = 20 } = {}) {
      const query = (q || "").trim();
      const params = { q: query, limit, include_bgg: includeBgg ? "true" : "false" };
      if (includeBgg || !window.bgbCache) {
        return window.api.get("/search", params);
      }
      const key = Game._searchKey(query, limit);
      const hit = window.bgbCache.get("game.search", key);
      if (hit) return hit;
      const data = await window.api.get("/search", params);
      // 3-minute TTL: long enough that a burst of typing/backspacing is
      // instant, short enough that the catalog stays reasonably fresh.
      window.bgbCache.set("game.search", key, data, 3 * 60 * 1000);
      return data;
    }

    /** Drop every cached library search. Call after a collection mutation so
     *  cached results reflect the new owned/wishlist status. */
    static invalidateSearch() {
      if (window.bgbCache) window.bgbCache.clear("game.search");
    }

    // Caller's most-recently-played distinct games (seed for the inline
    // game-picker dropdown on Gather). Cached under "game.recent":"self" so
    // bootstrap can seed it on login and the Gather screen renders without
    // a round-trip. Invalidated by Game.invalidateRecent() after play save.
    static recentlyPlayed(limit = 6) {
      return window.bgbCache.swr(
        "game.recent",
        "self",
        () => window.api.get("/games/recently-played", { limit }),
        { freshTtl: 24 * 60 * 60 * 1000, staleTtl: 7 * 24 * 60 * 60 * 1000 },
      );
    }

    /** Drop the recently-played cache so the next call refetches. Call after
     *  saving a play — the new game should appear at the top of the list. */
    static invalidateRecent() {
      if (window.bgbCache) window.bgbCache.clear("game.recent");
    }

    // Import a BGG game into the catalog and return the new GameSummary.
    static importBgg(bggId) {
      return window.api.post(`/games/import-bgg/${bggId}`);
    }

    accentColor() {
      // Fall back to the brand accent token rather than a literal: the old
// #C9922A was the pre-Lamplight gold and fails contrast on the light ground.
      return this.theme_color || this.expansion_color || "var(--accent)";
    }

    bggUrl() {
      return this.bgg_id ? `https://boardgamegeek.com/boardgame/${this.bgg_id}` : null;
    }

    rulebookUrl() {
      return this.rulebook_url || null;
    }

    playerRangeText() {
      const lo = this.min_players, hi = this.max_players;
      if (!lo && !hi) return "";
      if (lo === hi) return `${lo}P`;
      return `${lo || "?"}–${hi || "?"}P`;
    }

    playTimeText() {
      const m = this.playing_time;
      if (!m) return "";
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      const r = m % 60;
      return r ? `${h}h${r}m` : `${h}h`;
    }

    // ── Admin: image rehydration ─────────────────────────────────────────────

    /** List catalog games whose image_url or thumbnail_url is missing. */
    static adminMissingImages() {
      return window.api.get("/games/admin/missing-images");
    }

    /** Re-fetch box art + thumbnail from BGG for a single game. */
    static adminRefreshOneImage(gameId) {
      return window.api.post(`/games/admin/${gameId}/refresh-images`);
    }

    /** Bulk-rehost images for every catalog game with a missing or BGG-hosted URL.
     *  Throttled server-side; can take a while if many games need work. */
    static adminRefreshAllImages() {
      return window.api.post("/games/refresh-images");
    }

    /** Admin: set or clear a game's rulebook URL. Pass null/"" to clear. */
    static adminSetRulebookUrl(gameId, url) {
      const cleaned = (url || "").trim() || null;
      return window.api.patch(`/games/admin/${gameId}/rulebook-url`, { rulebook_url: cleaned })
        .then((r) => { Game.invalidateBundle(gameId); return r; });
    }
  }

  window.Game = Game;
})();
