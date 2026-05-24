// domain/buddy.js — Mutual friend graph.

(function () {
  const CACHE_NS = "buddy";
  const ALL_KEY = "all";
  const ALL_TTL_MS = 10 * 60 * 1000; // 10 min — see performance-caching.md

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

    // Combined preload for the gather-player picker. Accounts (accepted buddy
    // edges), ghosts (free-text players the user has logged before), and
    // recent played-with (real accounts ordered by shared-play count) all
    // fetched in parallel and cached for 10 min. The picker dropdown serves
    // from this cache so it opens with zero round-trips after first hit.
    static async allBuddies() {
      const hit = window.bgbCache && window.bgbCache.get(CACHE_NS, ALL_KEY);
      if (hit) return hit;
      const [accounts, ghosts, recent] = await Promise.all([
        Buddy.list().catch(() => []),
        Buddy.ghostPlayers().catch(() => []),
        Buddy.playedWith().catch(() => []),
      ]);
      const combined = {
        accounts: accounts || [],
        ghosts: ghosts || [],
        recent: recent || [],
      };
      if (window.bgbCache) window.bgbCache.set(CACHE_NS, ALL_KEY, combined, ALL_TTL_MS);
      return combined;
    }

    // Drop the combined cache so the next allBuddies() refetches. Call after
    // mutations that would change the roster: accept/unfriend, save a play
    // (which may add new ghost names or bump play counts).
    static invalidate() {
      if (window.bgbCache) window.bgbCache.clear(CACHE_NS);
    }
  }

  window.Buddy = Buddy;
})();
