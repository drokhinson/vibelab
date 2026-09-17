// domain/bga.js — Board Game Arena account linking + the history sweep.
//
// The thin API wrapper, shaped like domain/bgg.js. Everything about what the
// answers MEAN lives in domain/bga-import.js; this is only the calls.
//
// There is deliberately no `import` method here. The BGA source writes through
// the same POST /plays/import every other source uses — see bga-import.js
// run() — which is the whole payoff of answering one `ImportSource` interface.

(function () {
  // The sweep walks up to BGA_MAX_TABLES tables behind a two-second throttle
  // inside the handler, the same way POST /bgg/check does its eight-request
  // sweep. The client's 15s default would abort it routinely, and that abort
  // would be a lie: the server finishes either way, and the user would be told
  // "failed" about a sweep that ran. The server caps itself at
  // BGA_SWEEP_BUDGET_SECONDS, so this only has to outlive that — it still has
  // a deadline, so a stalled socket cannot hang the screen forever.
  const FETCH_TIMEOUT_MS = 300000;

  class Bga {
    /** Whether a BGA account is linked, and what the account step should say. */
    static status() { return window.api.get("/bga/link"); }

    /**
     * Sign in to Board Game Arena and store the session.
     *
     * The password reaches this function and goes no further: it is a property
     * of one request body, never assigned to anything that outlives the call,
     * and never written to a draft. See bga-import.js save().
     */
    static link(username, password) {
      return window.api.post("/bga/link", { username, password });
    }

    /** Forget the handle, the stored password and the session. */
    static unlink() { return window.api.del("/bga/link"); }

    /** Sweep the linked account's finished tables into reviewable drafts. */
    static fetchTables() {
      return window.api.post("/bga/tables/fetch", {}, { timeoutMs: FETCH_TIMEOUT_MS });
    }

    /**
     * How far the sweep has got.
     *
     * An in-process ledger on a single worker, so `state: "unknown"` is a
     * legitimate answer while the POST is perfectly alive — render it as
     * "still working", never as done or failed.
     */
    static progress() { return window.api.get("/bga/tables/progress"); }
  }

  window.Bga = Bga;
})();
