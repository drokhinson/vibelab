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
    cachedMyChapters(baseGameId, expansionIds) {
      if (!window.bgbCache || !baseGameId) return null;
      return window.bgbCache.get(CHAPTERS_NS, chaptersKey(baseGameId, expansionIds));
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
