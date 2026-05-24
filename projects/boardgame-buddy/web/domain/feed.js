// domain/feed.js — Feed page assembler. Thin wrapper over /feed cursor pagination.
//
// First-page is SWR-cached so opening the Feed view after a tab-switch
// renders from cache and refreshes in the background. Cursor pages (the
// infinite-scroll continuations) are not cached — they're append-only and
// each cursor key is a one-shot read.

(function () {
  const NS = "feed";
  const FIRST_KEY = "first";
  const FRESH_TTL_MS = 60 * 1000;        // tight: feed should feel live
  const STALE_TTL_MS = 10 * 60 * 1000;   // serve while we refresh

  class Feed {
    static async fetchPage({ cursor } = {}) {
      // Cursor-paginated reads bypass the cache — each cursor is a one-shot
      // window and the FE composes the running list view-side.
      if (cursor) {
        return window.api.get("/feed", { cursor, limit: 20 });
      }
      return window.bgbCache.swr(
        NS,
        FIRST_KEY,
        () => window.api.get("/feed", { limit: 20 }),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    }

    // Force the cached first page to refresh on the next read. Used by the
    // tab-focus warm refresh path and by Play.log() (which also patches the
    // cached page optimistically via prependPlay below).
    static async refreshFirstPage() {
      window.bgbCache.delete(NS, FIRST_KEY);
      return Feed.fetchPage({});
    }

    // Optimistically prepend a freshly-logged play to the cached first page
    // so the Feed view paints it instantly when the user returns from the
    // Log Play flow. The background refresh will replace this with the
    // server-composed page (including any new Hot Games / Suggested
    // Buddies cards that may have shifted).
    static prependPlay(playCard) {
      if (!playCard) return;
      const cached = window.bgbCache.get(NS, FIRST_KEY);
      if (!cached || !Array.isArray(cached.cards)) return;
      const next = { ...cached, cards: [playCard, ...cached.cards] };
      // Re-store with the same TTLs so the next read still treats it as fresh.
      window.bgbCache.setWithTtls(NS, FIRST_KEY, next, {
        freshTtl: FRESH_TTL_MS,
        staleTtl: STALE_TTL_MS,
      });
    }
  }

  window.Feed = Feed;
})();
