// domain/play.js — Logged play.

(function () {
  class Play {
    constructor(raw) { Object.assign(this, raw || {}); }

    static list({ gameId, buddyId, page = 1, perPage = 20 } = {}) {
      return window.api.get("/plays", {
        game_id: gameId,
        buddy_id: buddyId,
        page,
        per_page: perPage,
      });
    }

    static create(payload) { return window.api.post("/plays", payload); }
    static update(id, payload) { return window.api.put(`/plays/${id}`, payload); }
    static remove(id) { return window.api.del(`/plays/${id}`); }
  }

  window.Play = Play;
})();
