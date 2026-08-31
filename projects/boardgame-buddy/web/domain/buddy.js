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
    // Withdraw a request WE sent. Distinct from reject(), which is the
    // recipient's decline — same edge, opposite party, different meaning to
    // whoever is on the other end.
    static cancel(requestId)  { return window.api.post(`/buddies/${requestId}/cancel`, {}); }
    static unfriend(edgeId)   { return window.api.del(`/buddies/${edgeId}`); }

    // Profile search — returns ProfileSearchResult[]
    static searchProfiles(q) { return window.api.get("/profiles/search", { q }); }

    // Add by QR. The token is short-lived and stateless (see the backend's
    // buddy_qr_service) — never cache it and never persist it, because a
    // stored copy outlives the consent it stands for.
    static qrToken() { return window.api.post("/buddies/qr-token", {}); }

    // Redeem a scanned token: both users become buddies immediately, no
    // pending request. 410 = expired or forged, 400 = your own code,
    // 403 = blocked, 404 = the account is gone.
    static addByQr(token) { return window.api.post("/buddies/qr-add", { token }); }

    // "Buddies you may know" — the same ranked candidates the Feed rail
    // renders, as a standalone call so the Buddies screen doesn't have to
    // pull a feed page for them. Uncached: the RPC already excludes anyone
    // the viewer shares an edge with, so a stale copy would offer an Add
    // button for a request that's already sent.
    static suggested() { return window.api.get("/buddies/suggested"); }

    // The onboarding "Add buddies" step's list. A separate endpoint, not
    // suggested() with a bigger limit: that one only returns people the
    // viewer already shares a play or a buddy with, which is empty for the
    // account that was created ninety seconds ago — see migration 063. Each
    // candidate carries a `source` saying which tier it came from.
    static onboardingSuggestions(limit) {
      return window.api.get("/buddies/suggested/onboarding", limit ? { limit } : {});
    }

    // Multi-select send. Resolves { sent: string[], sent_count, failed:
    // [{user_id, detail}] } — a partial batch is the expected shape, not an
    // error, so callers report counts rather than branching on a throw.
    static sendRequests(targetUserIds) {
      return window.api.post("/buddies/requests/bulk", { target_user_ids: targetUserIds });
    }

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
    // recent played-with (real accounts ordered by shared-play count) in one
    // call — GET /play-partners is a single bgb_play_partners RPC. This used
    // to be three parallel requests, each paying its own auth lookup and its
    // own query fan-out. SWR-cached: 5min fresh, 30min stale, so the picker
    // dropdown opens with zero round-trips after the first hit.
    static allBuddies() {
      return window.bgbCache.swr(
        CACHE_NS,
        ALL_KEY,
        async () => {
          let data;
          try {
            data = await window.api.get("/play-partners");
          } catch (_) {
            data = null;
          }
          return {
            accounts: (data && data.accounts) || [],
            ghosts: (data && data.ghosts) || [],
            recent: (data && data.recent) || [],
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
      // Buddy System turns on the first accepted edge.
      if (window.Achievements && window.Achievements.invalidate) window.Achievements.invalidate();
    }
  }

  window.Buddy = Buddy;
})();
