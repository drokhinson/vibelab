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

  // POST /bgg/check and POST /bgg/push both run the same eight-request sweep
  // inside the handler before they can answer, for the same reason as above.
  const CHECK_TIMEOUT_MS = 120000;
  const PUSH_TIMEOUT_MS = 120000;

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

    // ── Comparison + push ───────────────────────────────────────────────────

    /**
     * Compare the BgB shelf against the live BGG collection, in both
     * directions, and import any game BgB's catalog has never seen so the
     * comparison can name it.
     *
     * A POST, not a GET: the catalog fill is a write. It writes to the GAME
     * catalog only — never to a shelf row — so a game it imports still reads
     * as "only on BGG" and the push still decides its fate.
     */
    static check() {
      return window.api.post("/bgg/check", {}, { timeoutMs: CHECK_TIMEOUT_MS });
    }

    /**
     * What POST /bgg/check is doing right now — the checklist's data source.
     *
     * Polled ALONGSIDE the in-flight check, not after it: the handler spends
     * most of its time in asyncio.sleep between throttled BGG calls, so the
     * event loop is free to answer this. Reads an in-process cache, so it is
     * the cheapest endpoint in the app.
     *
     * `state: "unknown"` means the server has no record — a restart, or a
     * worker that never ran this check. Callers must render that as STILL
     * WORKING; completion comes from check()'s own promise, never from here.
     */
    static checkProgress() { return window.api.get("/bgg/check/progress"); }

    /**
     * Push the shelf up to BoardGameGeek.
     *
     * NOT chained through _dropAchievements, and the caller must NOT call
     * invalidateImportedData(): both exist because a sync changes local rows
     * and flips the Geek Certified badge. A push writes nothing locally, so
     * dropping the status map and the feed would be pure cache churn.
     *
     * @param {string|null} [checkedAt] the comparison the user reviewed, so the
     *   server can say whether its own re-plan disagrees.
     */
    static push(checkedAt) {
      return window.api.post("/bgg/push", { checked_at: checkedAt || null },
                             { timeoutMs: PUSH_TIMEOUT_MS });
    }

    static pushStatus() { return window.api.get("/bgg/push/status"); }

    /**
     * True once the catalog fill a comparison kicked off has landed.
     *
     * Reads the CATALOG session counters, not the import ones: a check queues
     * kind='catalog' rows into the same table an import uses, and before
     * migration 006 they shared a window — which made a finished import read
     * as unfinished and made this exit instantly for anyone who had never run
     * an import. Same session-counter argument as importDrained otherwise.
     *
     * @param {{catalog_session_total?:number, catalog_session_done?:number, catalog_session_errored?:number}|null} status
     */
    static catalogFillDrained(status) {
      if (!status || !status.catalog_session_total) return true;
      return ((status.catalog_session_done || 0) + (status.catalog_session_errored || 0))
        >= status.catalog_session_total;
    }

    /**
     * True once every queued change has been sent or has failed — the exit
     * condition for the push poll. Same session-counter argument as
     * importDrained: a row left over from an abandoned run would otherwise
     * keep the poll running forever.
     *
     * @param {{session_total?:number, session_done?:number, session_errored?:number}|null} status
     */
    static pushDrained(status) {
      if (!status || !status.session_total) return true;
      return ((status.session_done || 0) + (status.session_errored || 0)) >= status.session_total;
    }
  }

  window.Bgg = Bgg;
})();
