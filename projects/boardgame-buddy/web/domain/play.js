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
    static create(payload) { return window.api.post("/plays", payload); }
    static update(id, payload) { return window.api.put(`/plays/${id}`, payload); }
    static remove(id) { return window.api.del(`/plays/${id}`); }
  }

  window.Play = Play;
})();
