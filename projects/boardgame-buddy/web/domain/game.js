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

    // Single ranked search. include_bgg=true appends BGG hits.
    static async search(q, { includeBgg = false, limit = 20 } = {}) {
      const data = await window.api.get("/search", {
        q,
        limit,
        include_bgg: includeBgg ? "true" : "false",
      });
      return data;
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
  }

  window.Game = Game;
})();
