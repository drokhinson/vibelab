// domain/release-notices.js — the what's-new popup's data, and the archive's.
//
// Purely informational: an admin writes a short note when something big ships,
// and the next time each user opens the app it appears once. Nothing is asked
// of the reader, so there is no dot, no badge and no row in
// domain/notifications.js — that registry is for transient things waiting on an
// answer, and this resolves by being read.
//
// DELIVERY IS /bootstrap, AND ONLY /bootstrap. That call runs on every visit —
// the warm boot path paints from cache and still fires it in the background
// (init.js#initAuth) — so the unseen list rides the payload rather than costing
// a second round trip. domain/bootstrap.js hands it to stage() and init.js
// picks it up with take(). Nothing here fetches on boot.
//
// The list is NOT cached. It is the one payload block whose whole meaning is
// "as of right now", and it is re-read every boot by construction, which is
// also why adding it did not need EXPECTED_BOOTSTRAP_VERSION bumped.

(function () {
  // Where the boot payload parks between /bootstrap landing and init.js being
  // ready to show it. A module local rather than a store slot: nothing
  // subscribes to it, and a store slot would invite a second consumer.
  let _pending = [];

  // One mark-seen write can be in flight at a time, and one retry. A failure
  // means the notices come back next boot, which is the right direction for
  // something informational — better one extra read than a swallowed
  // announcement.
  const RETRY_MS = 3000;

  const ReleaseNotices = {
    /** Park the unseen list from /bootstrap. Called by domain/bootstrap.js. */
    stage(list) {
      _pending = Array.isArray(list) ? list : [];
    },

    /** Take the parked list, clearing it. Called once by init.js. */
    take() {
      const list = _pending;
      _pending = [];
      return list;
    },

    /** Anything waiting, without consuming it. */
    peek() {
      return _pending;
    },

    /**
     * Advance the read watermark so the popup does not return.
     *
     * `through` is the newest published_at the user was actually SHOWN, never
     * now(): a notice published between /bootstrap and the dismissal must not
     * be marked seen without ever having been on screen, and since the admin
     * publishes from inside this same app that is an ordinary sequence rather
     * than a contrived race. The RPC behind this does a GREATEST, so a retry
     * with a stale value cannot walk the watermark backwards.
     *
     * Fire-and-forget by design — the deck closes on the same frame as the tap
     * and never waits on this. One retry, because the common failure is a
     * phone on a bad connection rather than a rejected request.
     */
    markSeen(through) {
      if (!through) return Promise.resolve(null);
      const send = () => window.api.post("/release-notices/seen", { through });
      return send()
        .catch(() => new Promise((r) => setTimeout(r, RETRY_MS)).then(send))
        .catch(() => null);
    },

    /** Every published notice, newest first — the Settings archive. */
    archive() {
      return window.api.get("/release-notices").then((res) => (res && res.items) || []);
    },

    // ── Admin ────────────────────────────────────────────────────────────────
    // Gated server-side by get_current_admin; ui/admin-gate.js keeps a
    // non-admin off the screen that calls these.

    adminList(status) {
      return window.api
        .get("/release-notices/admin", status ? { status } : undefined)
        .then((res) => (res && res.items) || []);
    },

    adminCreate(body) {
      return window.api.post("/release-notices/admin", body);
    },

    adminUpdate(id, patch) {
      return window.api.patch(`/release-notices/admin/${encodeURIComponent(id)}`, patch);
    },

    adminPublish(id) {
      return window.api.post(`/release-notices/admin/${encodeURIComponent(id)}/publish`);
    },

    adminUnpublish(id) {
      return window.api.post(`/release-notices/admin/${encodeURIComponent(id)}/unpublish`);
    },

    adminDelete(id) {
      return window.api.del(`/release-notices/admin/${encodeURIComponent(id)}`);
    },
  };

  window.ReleaseNotices = ReleaseNotices;
})();
