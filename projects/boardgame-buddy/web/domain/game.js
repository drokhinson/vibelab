// domain/game.js — Game catalog object.
// Hydrated from GameSummary / GameDetail backend shapes.

(function () {
  // ── Admin bulk-run plumbing ────────────────────────────────────────────────
  //
  // The five admin catalog runs share two things no other call here needs.
  //
  // `pass_no` is the drain counter. The server bounds each pass so it fits
  // inside the platform's request timeout, and the browser keeps asking until
  // `remaining` hits 0; pass 0 opens a fresh run log and anything above it
  // continues the one the last pass left, which is what makes twenty-five
  // requests read as one log. domain/admin-run-flow.js owns the loop.
  //
  // `timeoutMs` is not optional and not a tuning knob. api.js defaults every
  // request to a 15-SECOND deadline, and a bounded pass here is 30 seconds to
  // several minutes of throttled BoardGameGeek work — so without an explicit
  // deadline the browser aborts a pass that is running perfectly well, and the
  // drain stops with the catalog half filled. The caller sets it because only
  // the caller knows how big a bite it asked for.

  /** @param {{limit?:number, passNo?:number}=} opts */
  function _adminRunQuery(opts) {
    const o = opts || {};
    const parts = [];
    if (o.limit) parts.push(`limit=${encodeURIComponent(o.limit)}`);
    if (o.passNo) parts.push(`pass_no=${encodeURIComponent(o.passNo)}`);
    return parts.length ? `?${parts.join("&")}` : "";
  }

  /** @param {{timeoutMs?:number}=} opts */
  function _adminRunOpts(opts) {
    const o = opts || {};
    return o.timeoutMs ? { timeoutMs: o.timeoutMs } : undefined;
  }

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

    // Cache key for a library search — normalized query + limit. Expansion
    // inclusion is NOT in the key and does not need to be: only include_bgg=false
    // calls are cached (see search()), and every one of those passes the default.
    static _searchKey(q, limit) {
      return `${(q || "").trim().toLowerCase()}|${limit}`;
    }

    // Synchronous peek at the cached library-search result (or null). The
    // GameFinder uses this on its /search fallback path — when the on-device
    // catalog index (domain/catalog-index.js) is not available — to render
    // instantly on backspace/re-type and to decide whether it needs to show a
    // loading state at all.
    static cachedSearch(q, { limit = 20 } = {}) {
      if (!window.bgbCache) return null;
      return window.bgbCache.get("game.search", Game._searchKey(q, limit));
    }

    /**
     * Games from the cached result of the LONGEST cached query that is a
     * strict prefix of `q`, narrowed to `q`.
     *
     * Typing "catan" issues five distinct queries, and cachedSearch() misses
     * on all but an exact repeat — yet the answer to "cat" already contains
     * every "cata" the server would return. The finder paints these
     * immediately and replaces them when the real response lands.
     *
     * Provisional, never final: a cached page is capped at `limit`, so
     * narrowing it can miss rows the server would rank in once the query
     * gets more specific.
     *
     * @returns {Array<Object>} GameSummary rows, in their cached rank order.
     */
    static cachedSearchPrefix(q, { limit = 20 } = {}) {
      if (!window.bgbCache) return [];
      const query = (q || "").trim().toLowerCase();
      if (!query) return [];
      const suffix = `|${limit}`;
      let bestKey = null;
      let bestLen = -1;
      for (const key of window.bgbCache.keys("game.search")) {
        if (!key.endsWith(suffix)) continue;
        const cachedQ = key.slice(0, -suffix.length);
        // Strict prefix and strictly shorter — an exact match is
        // cachedSearch()'s job and is served as a final result, not this.
        if (!cachedQ || cachedQ.length >= query.length) continue;
        if (!query.startsWith(cachedQ)) continue;
        if (cachedQ.length > bestLen) { bestLen = cachedQ.length; bestKey = key; }
      }
      if (!bestKey) return [];
      const hit = window.bgbCache.peek("game.search", bestKey);
      const results = (hit && hit.results) || [];
      const out = [];
      for (const r of results) {
        const g = r && r.game;
        if (!g || !g.name) continue;
        if (!g.name.toLowerCase().includes(query)) continue;
        out.push(g);
      }
      return out;
    }

    // Single ranked search. include_bgg=true appends BGG hits.
    //
    // Library searches (include_bgg=false) are memoized in bgbCache under
    // "game.search" so re-typing a query the user already searched is instant
    // and doesn't re-hit the DB. Invalidated by Game.invalidateSearch() after
    // any collection mutation so a freshly-added game's status stays correct.
    // BGG searches bypass the cache — they hit the external BGG API (already
    // cached server-side) and are far less frequent.
    //
    // `signal` aborts the in-flight request; the finder passes one so a
    // superseded keystroke stops competing for the connection.
    static async search(q, { includeBgg = false, includeExpansions = false, limit = 20, signal = null } = {}) {
      const query = (q || "").trim();
      const params = {
        q: query,
        limit,
        include_bgg: includeBgg ? "true" : "false",
        include_expansions: includeExpansions ? "true" : "false",
      };
      const opts = signal ? { signal } : undefined;
      if (includeBgg || !window.bgbCache) {
        return window.api.get("/search", params, opts);
      }
      const key = Game._searchKey(query, limit);
      const hit = window.bgbCache.get("game.search", key);
      if (hit) return hit;
      const data = await window.api.get("/search", params, opts);
      // 3-minute TTL: long enough that a burst of typing/backspacing is
      // instant, short enough that the catalog stays reasonably fresh.
      // Memory-only: a search memo is never worth a reload, and writing one
      // through used to cost a stringify + setItem + a walk of every cached
      // entry on the main thread, per response, while the user was typing.
      window.bgbCache.setWithTtls("game.search", key, data, {
        freshTtl: 3 * 60 * 1000, staleTtl: 3 * 60 * 1000, persist: false,
      });
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
    // The on-device catalog index (domain/catalog-index.js) is dropped so the
    // game just imported is findable on the picker's next open rather than
    // after the index's ten-minute refresh.
    static importBgg(bggId) {
      return window.api.post(`/games/import-bgg/${bggId}`).then((game) => {
        if (window.CatalogIndex) window.CatalogIndex.invalidate();
        return game;
      });
    }

    accentColor() {
      return this.theme_color || this.expansion_color || "#C9922A";
    }

    bggUrl() {
      return this.bgg_id ? `https://boardgamegeek.com/boardgame/${this.bgg_id}` : null;
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

    /** Re-fetch box art + thumbnail from BGG for a single game.
     *  Busts the bundle cache so the admin sees the new art immediately rather
     *  than waiting out detailBundle's 30-minute fresh window. */
    static adminRefreshOneImage(gameId) {
      return window.api.post(`/games/admin/${gameId}/refresh-images`)
        .then((r) => { Game.invalidateBundle(gameId); return r; });
    }

    /** Re-host images for catalog games with a missing or BGG-hosted URL, in
     *  one bounded pass.
     *
     *  Throttled server-side at one BGG call plus two uploads per game, so the
     *  pass is SMALL and the deadline is long — see _adminRunOpts for why both
     *  are the caller's to set. `remaining` in the response drives the next
     *  pass, exactly like the three backfills below. */
    static adminRefreshAllImages(opts) {
      return window.api.post(`/games/refresh-images${_adminRunQuery(opts)}`, null, _adminRunOpts(opts))
        .then((r) => { Game.invalidateBundle(); return r; });
    }

    // ── Admin: the catalog metadata sweep (migration 045) ────────────────────
    // ONE trio where there were three — descriptions, BGG stats and publishers
    // each had their own list / refresh-one / backfill-all, and all three asked
    // BoardGameGeek the same question. One /thing?stats=1 response carries the
    // blurb, the stats, the publisher links AND the year, so the catalog was
    // walked three times to read one document.

    /** Catalog games short of a description, stats, publishers or a year.
     *
     *  Lists what is INCOMPLETE, not what is queued: a game BoardGameGeek has
     *  nothing more to give stays here with `checked_at` set, so the panel can
     *  say why rather than looking like a stalled queue. Each row carries
     *  `missing` — the field names — so the row line needs no ternaries. */
    static adminMissingMetadata() {
      return window.api.get("/games/admin/missing-metadata");
    }

    /** Re-read one game's BoardGameGeek record and write everything it gives.
     *  Also the escape hatch from the server's 90-day re-check window: a row an
     *  admin wants asked about again right now is asked about here. */
    static adminRefreshOneMetadata(gameId) {
      return window.api.post(`/games/admin/${gameId}/refresh-metadata`)
        .then((r) => { Game.invalidateBundle(gameId); return r; });
    }

    /** Fill every missing field for a batch of games, in one bounded pass.
     *
     *  The server batches 20 games per BGG call and caps the pass at `limit`,
     *  so a cold catalog needs several — `remaining` says how many are left and
     *  domain/admin-run-flow.js loops until it reads 0.
     *
     *  BOTH caches are dropped, and the second one is new with this sweep:
     *  it now fills `year_published`, which is what Discover's "New this year"
     *  rail filters on, so a stale bundle after a drain would be two rails
     *  wrong rather than one. Invalidating only helps the admin's own device;
     *  other clients age out on their own 30-minute TTL, which is acceptable
     *  for a one-off catalog fill. */
    static adminBackfillMetadata(opts) {
      return window.api.post(
        `/games/admin/backfill-metadata${_adminRunQuery(opts)}`, null, _adminRunOpts(opts),
      ).then((r) => {
        Game.invalidateBundle();
        if (window.Discovery && window.Discovery.invalidate) window.Discovery.invalidate();
        return r;
      });
    }

    /** Snapshot BGG's hot list now (migration 039) and import what the
     *  catalog lacks. Same call the daily cron makes; the Discover bundle is
     *  dropped so the next mount shows the new run. */
    static adminRefreshTrending(opts) {
      return window.api.post("/discover/admin/refresh-trending", null, _adminRunOpts(opts))
        .then((r) => {
          if (window.Discovery && window.Discovery.invalidate) window.Discovery.invalidate();
          return r;
        });
    }

    // RETIRED with migration 052: adminSetRulebookUrl(gameId, url), which
    // PATCHed /games/admin/{id}/rulebook-url. A rulebook link is a
    // reference-guide chapter now (domain/chapter.js#rulebookLinks) and that
    // endpoint no longer exists.
  }

  window.Game = Game;
})();
