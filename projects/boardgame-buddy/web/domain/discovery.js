// domain/discovery.js — the Discover tab's one bundle. Thin wrapper over
// GET /discover with the same SWR shape as domain/feed.js.
//
// One key per viewer ("self" under a user-bound cache), ten minutes fresh — the
// server caches the bundle for the same ten minutes, so a fresher client read
// would only re-read the server's copy — and a day stale, so a return visit
// paints the last bundle in the tap's own frame while the refresh lands behind
// it.
//
// Two things bust it. Any collection or play write (Collection
// .invalidateMyStatusMap, Play's _invalidatePlayDeps) drops the entry, because
// a game just shelved off a pick must not come straight back; and because the
// SERVER still holds its ten-minute copy, the next fetch after a bust asks with
// `refresh=true`. That flag lives here (_dirty) rather than on the view, since
// the write and the next mount are two different screens.

(function () {
  const NS = "discover";
  const KEY = "self";
  const FRESH_TTL_MS = 10 * 60 * 1000;
  const STALE_TTL_MS = 24 * 60 * 60 * 1000;

  let _dirty = false;

  // Section-header glyphs and the per-reason icon on a pick's caption. Every
  // name is in ui/icons.js; an unknown reason falls back to the star.
  const REASON_ICONS = {
    because_you_play: "dices",
    shared_mechanics: "sparkles",
    shared_categories: "layers",
    fits_your_table: "users",
    highly_rated: "star",
  };

  class Discovery {
    /** Synchronous peek for a first-frame paint; null when nothing is cached. */
    static cachedBundle() {
      if (!window.bgbCache) return null;
      return window.bgbCache.peek(NS, KEY);
    }

    /**
     * The bundle, SWR-cached. `force` (pull-to-refresh) drops the local entry
     * and bypasses the server cache too. A bust from a write does the same on
     * the next call without the caller having to know.
     */
    static async bundle({ force = false } = {}) {
      const refresh = force || _dirty;
      if (refresh && window.bgbCache) window.bgbCache.delete(NS, KEY);
      const query = refresh ? { refresh: "true" } : undefined;
      const bundle = await window.bgbCache.swr(
        NS,
        KEY,
        () => window.api.get("/discover", query),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
      // Cleared only once a fresh read has landed, so a fetch that failed
      // leaves the flag up for the retry.
      _dirty = false;
      if (window.store && window.store.set) window.store.set("discover", bundle);
      return bundle;
    }

    /**
     * Drop the cached bundle and remember that the server's copy is stale too.
     * Called from the collection and play write paths; cheap, so it does not
     * try to work out whether the write actually touched a pick.
     */
    static invalidate() {
      _dirty = true;
      if (window.bgbCache) window.bgbCache.delete(NS, KEY);
    }

    /** data-icon name for a pick's reason_kind. */
    static reasonIcon(kind) {
      return REASON_ICONS[kind] || "star";
    }
  }

  window.Discovery = Discovery;
})();
