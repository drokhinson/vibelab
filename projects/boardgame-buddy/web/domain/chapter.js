// domain/chapter.js — reference-guide chapter API wrappers.
//
// Each user builds their own per-game guide by adding chapters. Two
// flows: create new, or browse the per-game pool (sorted by popularity)
// and add an existing one.

(function () {
  // ── Reference-guide chapter cache ───────────────────────────────────────
  // The user's per-game guide doesn't change mid-session, so we cache it in
  // bgbCache (localStorage, bound per-user at auth). The widget seeds from
  // this for an instant paint, then revalidates; selecting a game for a play
  // warms it in the background so opening the guide on the Play screen or the
  // game-detail page is instant. Mutations clear the namespace so a just-edited
  // guide is never served stale.
  const CHAPTERS_NS = "chapters";
  const CH_FRESH = 10 * 60 * 1000; // instant-seed (get) window
  const CH_STALE = 30 * 60 * 1000; // outer bound retained in storage

  function chaptersKey(baseGameId, expansionIds) {
    const exp = (expansionIds || []).slice().sort().join(",");
    return exp ? `${baseGameId}|${exp}` : `${baseGameId}`;
  }

  const Chapter = {
    types() {
      return window.api.get("/chapter-types");
    },
    myChapters(gameId, { expansionIds } = {}) {
      const query = {};
      if (expansionIds && expansionIds.length) {
        query.expansion_ids = expansionIds.join(",");
      }
      return window.api.get(`/games/${gameId}/my-chapters`, query);
    },

    // Synchronous read of a cached my-chapters list (or null when absent/stale).
    //
    // Offline it reads through peek() instead of get(). get() only serves the
    // fresh window, so a guide cached an hour ago would read as absent — and
    // with no server to re-fetch from, the reference scroll on the Play screen
    // would simply be empty at exactly the table where nobody can look the
    // rules up any other way. A stale chapter list is the right answer there:
    // chapters change rarely, and the alternative is nothing.
    cachedMyChapters(baseGameId, expansionIds) {
      if (!window.bgbCache || !baseGameId) return null;
      const key = chaptersKey(baseGameId, expansionIds);
      return (window.BgbNet && window.BgbNet.isOffline())
        ? window.bgbCache.peek(CHAPTERS_NS, key)
        : window.bgbCache.get(CHAPTERS_NS, key);
    },
    // Write-through a freshly-fetched list.
    cacheMyChapters(baseGameId, expansionIds, rows) {
      if (!window.bgbCache || !baseGameId) return;
      window.bgbCache.setWithTtls(CHAPTERS_NS, chaptersKey(baseGameId, expansionIds), rows || [], {
        freshTtl: CH_FRESH,
        staleTtl: CH_STALE,
      });
    },
    // Fire-and-forget warm-up: skip when already fresh, otherwise fetch + cache.
    prefetchMyChapters(baseGameId, expansionIds = []) {
      if (!baseGameId || !window.session || !window.bgbCache) return;
      // Nothing to warm from offline — the request can only fail, and
      // cachedMyChapters already falls back to the stale window there.
      if (window.BgbNet && window.BgbNet.isOffline()) return;
      if (this.cachedMyChapters(baseGameId, expansionIds)) return;
      this.myChapters(baseGameId, { expansionIds })
        .then((rows) => this.cacheMyChapters(baseGameId, expansionIds, rows || []))
        .catch(() => {});
    },
    // Drop every cached guide. Called after any chapter mutation so the next
    // open refetches rather than serving the pre-mutation list.
    invalidateChaptersCache() {
      if (window.bgbCache) window.bgbCache.clear(CHAPTERS_NS);
    },
    pool(gameId, { q, chapterType, expansionIds } = {}) {
      const query = {};
      if (q) query.q = q;
      if (chapterType) query.chapter_type = chapterType;
      if (expansionIds && expansionIds.length) {
        query.expansion_ids = expansionIds.join(",");
      }
      return window.api.get(`/games/${gameId}/chapter-pool`, query);
    },
    create(gameId, payload) {
      return window.api.post(`/games/${gameId}/chapters`, payload);
    },
    // AI-draft a chapter of `chapterType` for this game. Returns
    // { chapter_type, title, content } — a draft for the editor to load into
    // its form. Saves nothing; the user reviews and hits Save themselves.
    // Slower than every other call here (a live LLM round-trip), so callers
    // must show a pending state.
    generate(gameId, chapterType) {
      return window.api.post(`/games/${gameId}/chapters/generate`, {
        chapter_type: chapterType,
      });
    },
    add(gameId, chapterId) {
      return window.api.post(`/games/${gameId}/my-chapters`, { chapter_id: chapterId });
    },
    remove(gameId, chapterId) {
      return window.api.del(`/games/${gameId}/my-chapters/${chapterId}`);
    },
    update(chapterId, payload) {
      return window.api.patch(`/chapters/${chapterId}`, payload);
    },
    delete(chapterId) {
      return window.api.del(`/chapters/${chapterId}`);
    },
    report(chapterId, reason) {
      return window.api.post(`/chapters/${chapterId}/report`, { reason: reason || null });
    },
    adminReports(status) {
      return window.api.get("/admin/chapter-reports", { status: status || "open" });
    },
    adminResolveReport(reportId) {
      return window.api.post(`/admin/chapter-reports/${reportId}/resolve`);
    },
  };

  window.Chapter = Chapter;
})();
