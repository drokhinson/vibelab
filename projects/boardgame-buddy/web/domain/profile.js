// domain/profile.js — single-call Profile bundle wrapper.
//
// Replaces the five separate /users/{id}/stats + /collection/grid (×3) +
// /collection + /buddies + /buddies/requests fan-out on Profile Self with
// one GET /profile/bundle round trip. Phase 3 (PR #245) added the backing
// `bgb_profile_bundle` RPC; this is the FE bridge.
//
// Cached in bgbCache namespace 'profile' keyed by viewerId|targetId.
// SWR: returns cached for the fresh window; serves cached + refreshes in the
// background for the stale window. The bootstrap loader pre-warms this
// namespace for the self profile on auth.

(function () {
  const NS = "profile";
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 5 * 60 * 1000;

  function _key(viewerId, targetId) {
    return `${viewerId}|${targetId || viewerId}`;
  }

  async function _fetch(target, viewerId, colPerPage, playsPerPage) {
    const params = new URLSearchParams({
      col_per_page: String(colPerPage),
      plays_per_page: String(playsPerPage),
    });
    if (target !== viewerId) params.set("target_user_id", target);
    const payload = await window.api.get(`/profile/bundle?${params.toString()}`);
    // Own bundle → refresh the durable last-play seed the Play tab paints
    // "Another Round" from. This is the choke point every refresh path goes
    // through, so plays logged on another device (or finalized joiner-side)
    // land here too. `recent_plays` present-but-empty is meaningful: the
    // viewer has no plays left, so the seed is cleared rather than left stale.
    if (target === viewerId && payload && Array.isArray(payload.recent_plays)
        && window.Play && window.Play.rememberLastPlay) {
      window.Play.rememberLastPlay(payload.recent_plays[0] || null);
    }
    // Same choke-point reasoning for the buddy-request badge: every refresh of
    // the self bundle passes through here — the hub's mount, the tab-focus
    // warmRefresh, and SWR's background revalidation — so publishing the count
    // once here keeps the nav dot honest without any screen having to ask.
    if (target === viewerId && window.Buddy && window.Buddy.publishPendingFromBundle) {
      window.Buddy.publishPendingFromBundle(payload);
    }
    return payload;
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
      if (force) {
        window.bgbCache.delete(NS, cacheKey);
      }
      return window.bgbCache.swr(
        NS,
        cacheKey,
        () => _fetch(target, viewerId, colPerPage, playsPerPage),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    },

    /**
     * Synchronous peek at an already-cached bundle (or null). Mirrors
     * Game.cachedSearch() — lets a view paint from the copy bootstrap warmed
     * at login instead of popping content in after the SWR round-trip.
     */
    cachedBundle(targetUserId) {
      if (!window.bgbCache) return null;
      const me = window.store.get("user");
      const viewerId = me && me.id;
      if (!viewerId) return null;
      // peek(), not get(): get() is fresh-window-only, and this namespace goes
      // stale after 60s — so the "paint from what bootstrap warmed" promise
      // above silently stopped holding a minute after login.
      return window.bgbCache.peek(NS, _key(viewerId, targetUserId)) || null;
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
