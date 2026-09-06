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

    /**
     * Fold a reaction the server has ACCEPTED into the cached first page.
     *
     * Reactions deliberately don't bust this entry (see domain/play.js) — a tap
     * would otherwise cost the whole feed a refetch, which is the cost the
     * counts-on-the-payload design exists to avoid. The feed view patches the
     * cards it is holding so the tap paints instantly, and inside one page
     * session that is enough: bgbCache hands its value out by reference, so the
     * cards the view mutates ARE the cached cards.
     *
     * A RELOAD is where that stopped being true. localStorage holds a copy
     * taken when the page was fetched, so the next launch painted the
     * pre-tap state out of the 24h stale window: a "Good game" you had just
     * taken back came straight back, and tapping it again was the only way to
     * get rid of it — for one session at a time. So the accepted write is
     * applied to the cached page here and re-persisted.
     *
     * Idempotent, because the cards may be the very objects the view already
     * patched: only the TRANSITION moves the count, and the entry is
     * re-persisted whether or not this call was the one that changed it.
     *
     * @param {string[]} playIds the plays the server actually touched
     * @param {boolean} reacted  true after a react, false after an unreact
     */
    static applyReaction(playIds, reacted) {
      if (!window.bgbCache || !Array.isArray(playIds) || !playIds.length) return;
      const page = window.bgbCache.peek(NS, FIRST_KEY);
      if (!page || !Array.isArray(page.cards)) return;
      const ids = new Set(playIds);
      const me = (window.store && window.store.get && window.store.get("user")) || null;
      const myId = me && me.id;
      let matched = false;
      for (const card of page.cards) {
        if (card.kind !== "play" || !ids.has(card.play_id)) continue;
        matched = true;
        if (!!card.viewer_reacted !== reacted) {
          card.viewer_reacted = reacted;
          card.reaction_count = Math.max(0, (card.reaction_count || 0) + (reacted ? 1 : -1));
        }
        // Rebuilt rather than pushed/spliced so the viewer appears exactly
        // once however many times this runs over the same card.
        const others = (card.reactors || []).filter((r) => r && r.user_id !== myId);
        card.reactors = reacted && myId
          ? [{
              user_id: myId,
              display_name: (me && me.display_name) || "You",
              avatar: (me && me.avatar) || null,
            }, ...others]
          : others;
      }
      if (matched) window.bgbCache.persist(NS, FIRST_KEY);
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
