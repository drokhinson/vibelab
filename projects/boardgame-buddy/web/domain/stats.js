// domain/stats.js — Strava-style aggregate stats for a profile.

(function () {
  const NS = "stats";
  const DETAIL_NS = "stats.detail";
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 10 * 60 * 1000;
  // The Stats spoke's payload is eleven aggregates over the user's whole play
  // history — it moves once a game night, not once a minute, and it is the
  // most expensive read in the app. A longer fresh window keeps re-entering
  // the screen free; Play.log() invalidates it outright, which is what
  // actually needs to repaint it.
  const DETAIL_FRESH_TTL_MS = 5 * 60 * 1000;
  const DETAIL_STALE_TTL_MS = 60 * 60 * 1000;

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

    /**
     * The Stats spoke's whole payload — podium, per-game breakdown, nemesis,
     * rhythm, shelf, table size, taste, comeback, co-op record, personal
     * bests. Self only; there is no other-user variant of this endpoint.
     *
     * @returns {Promise<Object>} the `bgb_user_stats_detail` payload. Every
     *   top-level key is always present; `nemesis`, `table_size.avg` and
     *   `rhythm.busiest_weekday` are null when there's nothing to compute.
     */
    static detail() {
      const me = window.store.get("user");
      if (!me) return Promise.resolve(null);
      return window.bgbCache.swr(
        DETAIL_NS,
        me.id,
        () => window.api.get("/users/me/stats/detail"),
        { freshTtl: DETAIL_FRESH_TTL_MS, staleTtl: DETAIL_STALE_TTL_MS },
      );
    }

    /** Synchronous stale-tolerant read of the detail payload, or null. Lets
     *  the spoke paint before its SWR read resolves — including after a hard
     *  reload, since bgbCache writes through to localStorage. */
    static cachedDetail() {
      const me = window.store.get("user");
      if (!me) return null;
      return window.bgbCache.peek(DETAIL_NS, me.id);
    }

    // Drop the cached stats for one user (or all when omitted). Called from
    // Play.log() so the viewer's own counts repaint after logging a play.
    // Both namespaces go together: a new play moves the hub's card and every
    // block on the spoke, and leaving the detail entry behind would show a
    // podium that disagrees with the Plays list one tap away.
    static invalidate(userId) {
      if (userId == null) {
        window.bgbCache.clear(NS);
        window.bgbCache.clear(DETAIL_NS);
      } else {
        window.bgbCache.delete(NS, userId);
        window.bgbCache.delete(DETAIL_NS, userId);
      }
    }

  }

  window.Stats = Stats;
})();
