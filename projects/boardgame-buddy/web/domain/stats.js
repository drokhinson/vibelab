// domain/stats.js — Strava-style aggregate stats for a profile.

(function () {
  const NS = "stats";
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 10 * 60 * 1000;

  class Stats {
    static for(userId) {
      const me = window.store.get("user");
      const isSelf = me && userId === me.id;
      const path = isSelf ? "/users/me/stats" : `/users/${userId}/stats`;
      return window.bgbCache.swr(
        NS,
        userId,
        () => window.api.get(path),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    }

    // Drop the cached stats for one user (or all when omitted). Called from
    // Play.log() so the viewer's own counts repaint after logging a play.
    static invalidate(userId) {
      if (userId == null) window.bgbCache.clear(NS);
      else window.bgbCache.delete(NS, userId);
    }

  }

  window.Stats = Stats;
})();
