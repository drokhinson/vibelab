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
  // Long stale window on purpose: this is what lets a refresh paint the
  // last-seen feed immediately rather than sitting on a skeleton while the
  // network answers. Every read past the fresh window still fires a background
  // refresh, and any play write deletes the entry outright (_invalidatePlayDeps
  // in domain/play.js), so the only thing this buys is a stale-but-instant
  // first frame. Keep in sync with TTLS.feedFirst in domain/bootstrap.js.
  const STALE_TTL_MS = 24 * 60 * 60 * 1000;

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

    // Drop the cached first page and re-fetch it. Two callers, both wanting
    // the new page warm before the user looks at it: the tab-focus warm
    // refresh, and any play mutation (save, delete) that just changed what
    // the first page should contain. Safe to fire-and-forget — a read that
    // arrives mid-flight joins the same request through bgbCache's
    // single-flight map rather than opening a second one.
    static async refreshFirstPage() {
      window.bgbCache.delete(NS, FIRST_KEY);
      return Feed.fetchPage({});
    }
  }

  window.Feed = Feed;
})();
