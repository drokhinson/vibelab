// domain/buddy.js — Mutual friend graph.

(function () {
  const CACHE_NS = "buddy";
  const ALL_KEY = "all";
  // 24h fresh / 7d stale: the combined buddies/ghosts/recent bundle only
  // mutates when the user finalizes a play (new ghost names, bumped
  // played-with counts) or edits the friend graph (accept / unfriend /
  // link / merge ghost). Each of those mutation sites calls
  // Buddy.invalidate(), so the cache is the source of truth between them.
  const FRESH_TTL_MS = 24 * 60 * 60 * 1000;
  const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    static mergeGhosts(sourceDisplayName, targetDisplayName) {
      return window.api.post("/ghost-players/merge", {
        source_display_name: sourceDisplayName,
        target_display_name: targetDisplayName,
      });
    }

    // Combined preload for the gather-player picker. Accounts (accepted buddy
    // edges), ghosts (free-text players the user has logged before), and
    // recent played-with (real accounts ordered by shared-play count) all
    // fetched in parallel. SWR-cached: 5min fresh, 30min stale. The picker
    // dropdown serves from this cache so it opens with zero round-trips
    // after first hit.
    static allBuddies() {
      return window.bgbCache.swr(
        CACHE_NS,
        ALL_KEY,
        async () => {
          const [accounts, ghosts, recent] = await Promise.all([
            Buddy.list().catch(() => []),
            Buddy.ghostPlayers().catch(() => []),
            Buddy.playedWith().catch(() => []),
          ]);
          return {
            accounts: accounts || [],
            ghosts: ghosts || [],
            recent: recent || [],
          };
        },
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
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
