// domain/bgg.js — BoardGameGeek account linking + sync.

(function () {
  // POST /bgg/sync is not a normal request. The handler fetches the whole
  // collection AND the whole play history from BGG's xmlapi2 — several
  // throttled calls, plus BGG's own "still preparing your collection"
  // back-off — before it can answer. The client's 15s default aborts a
  // mid-size account routinely, and that abort is a lie: the server finishes
  // the sync and queues the background worker either way, so the user is told
  // "sync failed" about an import that is running. Give the call a deadline
  // that matches the work it is waiting on; it still has one, so a stalled
  // socket can't hang the screen forever.
  const SYNC_TIMEOUT_MS = 120000;

  // Linking or unlinking flips the Geek Certified badge, so both drop the
  // cached achievements payload. Chained on the promise rather than fired
  // beside the call: a failed link must not invalidate anything.
  function _dropAchievements(result) {
    if (window.Achievements && window.Achievements.invalidate) window.Achievements.invalidate();
    return result;
  }

  class Bgg {
    static status()           { return window.api.get("/bgg/sync/status"); }
    static link(username, password) {
      return window.api.post("/bgg/link", { username, password }).then(_dropAchievements);
    }
    static unlink()           { return window.api.del("/bgg/link").then(_dropAchievements); }
    // A sync writes plays, which moves half the catalog.
    static sync() {
      return window.api
        .post("/bgg/sync", {}, { timeoutMs: SYNC_TIMEOUT_MS })
        .then(_dropAchievements);
    }

    /**
     * True once every game this sync session queued has resolved — the exit
     * condition for the status poll on every surface that runs an import.
     *
     * Reads the SESSION counters, not the lifetime `pending_count`: a row
     * left over from an earlier failed sync would otherwise keep the poll
     * running forever on a session that finished cleanly.
     *
     * @param {{session_total?:number, session_done?:number, session_errored?:number}|null} status
     */
    static importDrained(status) {
      if (!status || !status.session_total) return true;
      return ((status.session_done || 0) + (status.session_errored || 0)) >= status.session_total;
    }

    /**
     * A sync landed: the collection status map and the feed both hold rows
     * this import just changed. Called by every surface that finishes one.
     */
    static invalidateImportedData() {
      if (window.Collection) window.Collection.invalidateMyStatusMap();
      if (window.store) window.store.invalidate("feed");
    }
  }

  window.Bgg = Bgg;
})();
