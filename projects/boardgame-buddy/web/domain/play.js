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
    // Write just the photo column. PUT /plays/{id} is a FULL replacement —
    // it deletes and re-inserts every player and expansion row — so routing
    // a photo attach through it cost twelve round trips and churned rows
    // that hadn't changed. This is one.
    static attachPhoto(id, photoUrl) {
      return window.api.patch(`/plays/${id}/photo`, { photo_url: photoUrl })
        .then((r) => { _invalidatePlayDeps(); return r; });
    }
    static remove(id) {
      return window.api.del(`/plays/${id}`).then((r) => { _invalidatePlayDeps(); return r; });
    }
    // Self-remove from a play you didn't take part in. The backend turns your
    // player row into a ghost (keeps the play for its owner) rather than
    // deleting it. Busts the same caches as any other play mutation so your
    // history/stats drop it on next read.
    static leave(id) {
      return window.api.post(`/plays/${id}/leave`, {}).then((r) => { _invalidatePlayDeps(); return r; });
    }

    // Public handle on the same invalidation the mutations above run. Exists
    // for writes that create a play without going through this class —
    // PlaySession.finalizeLobby() posts to /sessions/{code}/finalize, which is
    // a play create in everything but the URL and left every one of these
    // caches stale.
    static invalidateDeps() { _invalidatePlayDeps(); }
  }

  function _invalidatePlayDeps() {
    if (window.Profile && window.Profile.invalidate) window.Profile.invalidate();
    if (window.Game && window.Game.invalidateBundle) window.Game.invalidateBundle();
    // Stats live in their own cache namespace now — clear so the next
    // Profile mount re-pulls accurate plays/wins counts.
    if (window.Stats && window.Stats.invalidate) window.Stats.invalidate();
    // Drop the cached feed first page; the next Feed mount triggers a fresh
    // fetch. Callers that want the new page warm before the user gets there
    // (the host save flow) follow up with Feed.refreshFirstPage().
    if (window.bgbCache) window.bgbCache.delete("feed", "first");
    if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
    window.store.invalidate("feed");
  }

  window.Play = Play;
})();
