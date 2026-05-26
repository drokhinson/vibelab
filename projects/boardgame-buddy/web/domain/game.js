// domain/game.js — Game catalog object.
// Hydrated from GameSummary / GameDetail backend shapes.

(function () {
  class Game {
    constructor(raw) {
      Object.assign(this, raw || {});
    }

    static fromRaw(raw) { return new Game(raw || {}); }

    static async fetch(id) {
      const raw = await window.api.get(`/games/${id}`);
      return new Game(raw);
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

    // Single ranked search. include_bgg=true appends BGG hits.
    static async search(q, { includeBgg = false, limit = 20 } = {}) {
      const data = await window.api.get("/search", {
        q,
        limit,
        include_bgg: includeBgg ? "true" : "false",
      });
      return data;
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
      return this.theme_color || this.expansion_color || "#C9922A";
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
