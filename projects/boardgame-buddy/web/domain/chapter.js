// domain/chapter.js — reference-guide chapter API wrappers.
//
// Each user builds their own per-game guide by adding chapters. Two
// flows: create new, or browse the per-game pool (sorted by popularity)
// and add an existing one.

(function () {
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
