// domain/profile.js — single-call Profile bundle wrapper.
//
// Replaces the five separate /users/{id}/stats + /collection/grid (×3) +
// /collection + /buddies + /buddies/requests fan-out on Profile Self with
// one GET /profile/bundle round trip. Phase 3 (PR #245) added the backing
// `bgb_profile_bundle` RPC; this is the FE bridge.
//
// Cached in bgbCache namespace 'profile' keyed by viewerId:targetId.
// 60s TTL — short enough that a mutation-invalidate isn't required for
// non-critical staleness windows, long enough to absorb a back-and-forth
// like Profile → Game Detail → Profile.

(function () {
  const NS = "profile";
  const TTL_MS = 60 * 1000;

  function _key(viewerId, targetId) {
    return `${viewerId}|${targetId || viewerId}`;
  }

  const Profile = {
    /**
     * Fetch the Profile bundle for `targetUserId` (defaults to caller).
     * Returns the raw JSON from /profile/bundle — see bgb_profile_bundle for
     * the shape. Buddies / buddy_requests_* are null unless viewer = target.
     */
    async bundle(targetUserId, { force = false, colPerPage = 12, playsPerPage = 10 } = {}) {
      const me = window.store.get("user");
      const viewerId = me && me.id;
      if (!viewerId) throw new Error("Not authenticated");
      const target = targetUserId || viewerId;
      const cacheKey = _key(viewerId, target);
      if (!force) {
        const hit = window.bgbCache.get(NS, cacheKey);
        if (hit) return hit;
      }
      const params = new URLSearchParams({
        col_per_page: String(colPerPage),
        plays_per_page: String(playsPerPage),
      });
      if (target !== viewerId) params.set("target_user_id", target);
      const data = await window.api.get(`/profile/bundle?${params.toString()}`);
      window.bgbCache.set(NS, cacheKey, data, TTL_MS);
      return data;
    },

    /** Invalidate the bundle for one (viewer, target) pair, or all when omitted. */
    invalidate(targetUserId) {
      if (targetUserId == null) {
        window.bgbCache.clear(NS);
        return;
      }
      const me = window.store.get("user");
      const viewerId = me && me.id;
      if (!viewerId) return;
      window.bgbCache.delete(NS, _key(viewerId, targetUserId));
    },
  };

  window.Profile = Profile;
})();
