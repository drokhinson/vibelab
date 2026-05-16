// domain/buddy.js — Mutual friend graph.

(function () {
  class Buddy {
    constructor(raw) { Object.assign(this, raw || {}); }

    static list() { return window.api.get("/buddies"); }

    static requests() { return window.api.get("/buddies/requests"); }

    static sendRequest(targetUserId) {
      return window.api.post("/buddies/request", { target_user_id: targetUserId });
    }

    static accept(requestId)  { return window.api.post(`/buddies/${requestId}/accept`, {}); }
    static reject(requestId)  { return window.api.post(`/buddies/${requestId}/reject`, {}); }
    static unfriend(edgeId)   { return window.api.del(`/buddies/${edgeId}`); }

    // Profile search — returns ProfileSearchResult[]
    static searchProfiles(q) { return window.api.get("/profiles/search", { q }); }

    // Played-with discovery + ghost-player linking.
    static playedWith()   { return window.api.get("/played-with"); }
    static ghostPlayers() { return window.api.get("/ghost-players"); }
    static linkGhost(displayName, targetUserId) {
      return window.api.post("/ghost-players/link", {
        display_name: displayName,
        target_user_id: targetUserId,
      });
    }
  }

  window.Buddy = Buddy;
})();
