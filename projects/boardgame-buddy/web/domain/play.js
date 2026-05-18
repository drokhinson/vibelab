// domain/play.js — Logged play.

(function () {
  class Play {
    constructor(raw) { Object.assign(this, raw || {}); }

    static list({ gameId, buddyId, search, userId, page = 1, perPage = 20 } = {}) {
      return window.api.get("/plays", {
        game_id: gameId,
        buddy_id: buddyId,
        user_id: userId || undefined,
        search: search || undefined,
        page,
        per_page: perPage,
      });
    }

    static get(id) { return window.api.get(`/plays/${id}`); }

    // Any play mutation can shift Profile stats, recent_plays, and the
    // played-not-owned shelf; it can also change Game Detail's recent_plays
    // for that game. Bust the bundle caches so the next visit re-hydrates.
    static create(payload) {
      return window.api.post("/plays", payload).then((r) => { _invalidatePlayDeps(); return r; });
    }
    static update(id, payload) {
      return window.api.put(`/plays/${id}`, payload).then((r) => { _invalidatePlayDeps(); return r; });
    }
    static remove(id) {
      return window.api.del(`/plays/${id}`).then((r) => { _invalidatePlayDeps(); return r; });
    }
  }

  function _invalidatePlayDeps() {
    if (window.Profile && window.Profile.invalidate) window.Profile.invalidate();
    if (window.Game && window.Game.invalidateBundle) window.Game.invalidateBundle();
    window.store.invalidate("feed");
  }

  window.Play = Play;
})();
