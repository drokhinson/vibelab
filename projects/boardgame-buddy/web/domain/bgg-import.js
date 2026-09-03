// @ts-check
// domain/bgg-import.js — the BoardGameGeek catalog-import queue.
//
// AN IMPORT OUTLIVES THE SHEET THAT STARTED IT. That is the whole reason this
// file exists rather than the work sitting inside widgets/bgg-import-sheet.js:
// POST /games/import-bgg fetches and normalises a game out of BGG's xmlapi2,
// which is slow enough that the user closes the sheet and carries on. When the
// widget owned the request, closing it left the import running with nobody to
// report to — the game appeared in the catalog silently, some seconds later,
// with no acknowledgement anywhere. Here the job is module state, so the sheet
// is only ever a view onto it, and ui/bgg-import-toast.js announces the finish
// whether or not anything is open.
//
// IMPORTING IS NOT SHELVING. Import puts a game in the shared BgB catalog,
// where it is visible to everyone; adding it to your collection or wishlist is
// a second, separate act — see addToShelf() below. The modal this replaced
// fused the two (import -> Collection.add in one tap), which meant browsing
// BGG to see whether BgB had something at all silently filled your shelf with
// it. Two steps, two taps, two undo stories.
//
// State is per session and deliberately not persisted: what survives a reload
// is the catalog row the import created, which every other surface reads
// normally. This map only exists so a re-opened sheet can show what it did.

(function () {
  const STORE_KEY = "bggImport";

  // Namespace of the paged catalog cache the Add Games screen reads
  // (views/add-games-view.js). An import is the one thing that changes those
  // pages, so this is the one place that has to drop them.
  const CATALOG_NS = "game.catalog";

  /**
   * @typedef {Object} ImportJob
   * @property {number} bggId
   * @property {string} name          Name as BGG gave it — the only label
   *   available while the import is still running.
   * @property {"importing"|"done"|"error"} state
   * @property {any} game             The imported GameSummary, once there is one.
   * @property {string} error         Message for the error state.
   * @property {"owned"|"wishlist"|null} shelf  Set by addToShelf() — step two.
   * @property {"owned"|"wishlist"} shelfIntent  Which shelf step two offers:
   *   the one the user was browsing when they started the import. A preference
   *   for the button's label and target, never something start() acts on.
   * @property {boolean} shelving     A shelf write is in flight.
   */

  /** @type {Map<number, ImportJob>} */
  const jobs = new Map();

  /** Publish. store.set() bails when the value is identical, so this hands out
   *  a fresh array every time; subscribers re-read through get(). */
  function publish() {
    window.store.set(STORE_KEY, Array.from(jobs.values()));
  }

  /** Merge fields into one job and publish. @param {number} bggId
   *  @param {Partial<ImportJob>} fields */
  function patch(bggId, fields) {
    const cur = jobs.get(bggId);
    if (!cur) return;
    jobs.set(bggId, Object.assign({}, cur, fields));
    publish();
  }

  const BggImport = {
    /**
     * The job for a BGG id, or null. The sheet renders every row through this,
     * so a row re-entered after a close-and-reopen shows where it got to.
     * @param {number} bggId
     * @returns {ImportJob|null}
     */
    get(bggId) {
      return jobs.get(Number(bggId)) || null;
    },

    /** Every job this session, newest last. @returns {ImportJob[]} */
    all() {
      return Array.from(jobs.values());
    },

    /** True while at least one import is on the wire. */
    get busy() {
      for (const j of jobs.values()) if (j.state === "importing") return true;
      return false;
    },

    /**
     * Import a BGG game into the shared catalog. Idempotent per id while one
     * is running or has already succeeded — a second tap on a row whose import
     * is in flight must not open a second request.
     *
     * Never rejects: the failure is a job state the row and the notification
     * both read, not something a caller has to catch. The returned promise
     * settles with the finished job.
     *
     * @param {{ bgg_id:number, name?:string }} hit  A row from /search's bgg_results.
     * @param {{ shelf?: "owned"|"wishlist", silent?: boolean }} [opts]
     *   `shelf` — which shelf step two should offer. Recorded, not acted on.
     *   `silent` — skip the completion notification. For a row BGG already
     *   reported as `already_in_db`: the call is a lookup for the catalog id,
     *   nothing is imported, and announcing an import that did not happen is
     *   a lie the user would have to reconcile against their own library.
     * @returns {Promise<ImportJob>}
     */
    async start(hit, opts) {
      const bggId = Number(hit && hit.bgg_id);
      if (!bggId) throw new Error("BggImport.start: bgg_id is required");
      const existing = jobs.get(bggId);
      if (existing && existing.state !== "error") return existing;

      const name = (hit && hit.name) || (existing && existing.name) || "This game";
      jobs.set(bggId, {
        bggId, name, state: "importing", game: null, error: "",
        shelf: (existing && existing.shelf) || null, shelving: false,
        shelfIntent: (opts && opts.shelf) || (existing && existing.shelfIntent) || "owned",
      });
      publish();

      try {
        const game = await window.Game.importBgg(bggId);
        patch(bggId, { state: "done", game, name: (game && game.name) || name, error: "" });
        // A silent call is a LOOKUP of a row the catalog already had, so
        // nothing downstream of it changed: no cache to drop, no screen to
        // repaint, nothing to announce.
        if (!(opts && opts.silent)) {
          // The catalog pages and every cached library search predate this
          // row; both would otherwise keep answering "not here" for a game
          // that now is. Dropped here rather than at a call site so it happens
          // whether or not anything is still mounted.
          if (window.bgbCache) window.bgbCache.clear(CATALOG_NS);
          window.Game.invalidateSearch();
          // Screens repaint off this rather than a callback the sheet would
          // have taken to its grave when the user closed it.
          document.dispatchEvent(new CustomEvent("bgg-imported", { detail: { game } }));
          BggImport.notify(jobs.get(bggId));
        }
      } catch (e) {
        patch(bggId, {
          state: "error",
          error: (e && e.message) || "Import failed — try again.",
        });
        // Failures are announced even when the call was a silent lookup: the
        // user pressed something and it did not work.
        BggImport.notify(jobs.get(bggId));
      }
      return /** @type {ImportJob} */ (jobs.get(bggId));
    },

    /**
     * Step two: put an imported game on a shelf. Separate from start() on
     * purpose — see the header.
     *
     * @param {number} bggId
     * @param {"owned"|"wishlist"} shelf
     * @returns {Promise<boolean>} false when the write failed (the job carries
     *   the reason).
     */
    async addToShelf(bggId, shelf) {
      const job = jobs.get(Number(bggId));
      if (!job || !job.game || job.shelving || job.shelf === shelf) return false;
      patch(job.bggId, { shelving: true, error: "" });
      try {
        await window.Collection.add(job.game.id, shelf);
      } catch (e) {
        patch(job.bggId, {
          shelving: false,
          error: (e && e.message) || "Couldn't add — try again.",
        });
        return false;
      }
      // Patch the shared status map so every live grid paints the new pill
      // this frame; it also fires `status-changed`, which is what the Add
      // Games rows behind the sheet are listening on.
      window.Collection.applyLocalStatus(job.game.id, shelf);
      patch(job.bggId, { shelving: false, shelf, error: "" });
      return true;
    },

    /**
     * The completion notification. Split out from start() so the sheet can
     * suppress nothing and a caller can re-announce if it ever needs to.
     * @param {ImportJob|undefined} job
     */
    notify(job) {
      if (!job || !window.BggImportToast) return;
      window.BggImportToast.show(job);
    },

    /** Subscribe to job changes. Returns an unsubscribe fn. @param {() => void} fn */
    subscribe(fn) {
      return window.store.subscribe(STORE_KEY, fn);
    },

    /** Drop every job. Sign-out, and the sheet's own "start again". */
    reset() {
      jobs.clear();
      publish();
    },
  };

  window.BggImport = BggImport;
})();
