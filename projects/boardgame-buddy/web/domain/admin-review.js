// domain/admin-review.js — the admin review queues behind the Settings gear.
//
// Publishes three store slots (see domain/store.js) from ONE
// /admin/review-counts call: open chapter reports, games missing images, games
// missing descriptions. domain/notifications.js turns them into the gear's dot
// and the per-row badges in the Settings admin card.
//
// One call rather than three, and counts rather than lists: the dot is on the
// global header, so this runs on every boot for every admin. Deriving the
// numbers client-side would mean fetching three full lists — hundreds of
// GameSummary rows mid-backfill — to arrive at three integers.
//
// NON-ADMINS NEVER FETCH. load() returns early on them, which is what keeps
// the slots at 0 and the dot dark; the endpoint would 403 anyway, but a 403 on
// every boot for every ordinary user is noise in the logs and a wasted round
// trip. store.reset() re-zeroes the slots on sign-out.

(function () {
  const AdminReview = {
    /** Is the signed-in user an admin? The gate for every call below. */
    isAdmin() {
      const me = window.store.get("user");
      return !!(me && me.is_admin);
    },

    /**
     * Fetch the counts and publish them. Resolves to the counts, or null when
     * the user is not an admin or the call failed.
     *
     * Failure deliberately leaves the slots where they were rather than
     * zeroing them: a flaky network should not silently clear a dot that says
     * there is work waiting. Same posture as init.js's ghost-suggestion warm.
     */
    async load() {
      if (!AdminReview.isAdmin()) return null;
      try {
        const counts = await window.api.get("/admin/review-counts");
        AdminReview.publish(counts);
        return counts;
      } catch (_) {
        return null;
      }
    },

    /** Write a counts payload into the store slots. */
    publish(counts) {
      if (!counts) return;
      const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
      window.store.set("adminChapterReportCount", n(counts.chapter_reports));
      window.store.set("adminMissingImageCount", n(counts.missing_images));
      window.store.set("adminMissingDescriptionCount", n(counts.missing_descriptions));
    },

    /**
     * Re-read the counts after an admin acted on something.
     *
     * Called from the admin spokes rather than having each one patch its own
     * slot: resolving a report or running a backfill can move a count the
     * acting screen doesn't own (a backfill that 404s a game leaves it in the
     * other queue), and one count call is cheaper than getting that wrong.
     */
    refresh() {
      return AdminReview.load();
    },
  };

  window.AdminReview = AdminReview;
})();
