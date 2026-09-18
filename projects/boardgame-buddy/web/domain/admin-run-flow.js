// @ts-check
// domain/admin-run-flow.js — the admin catalog runs, as state that outlives
// every screen showing them.
//
// WHY THIS IS A DOMAIN OBJECT AND NOT VIEW STATE. Same argument as
// domain/bgg-sync-flow.js: a run is kicked off from a routed screen, and
// router.go() unmounts the screen you came from. If the drain loop lived on
// either surface, walking to the Feed mid-run would stop it — which is exactly
// the thing the operator is promised will not happen. So the POSTs, the drain
// and the polls live here, the three surfaces subscribe, and none of them owns
// anything.
//
// The three surfaces:
//   • views/admin-run-view.js       the log
//   • views/settings-view.js        the status pill on each admin row
//   • widgets/admin-backfill-panel.js  the same pill on each panel
//
// All read snapshot() and re-render on the "adminRun" store key. Every publish
// is a NEW object because Store.set() early-returns on ===.
//
// WHAT SURVIVES WHAT, because it is not uniform:
//   • IN-APP NAVIGATION survives everything. The flow is a singleton; nothing
//     it is doing is attached to a view.
//   • A CLOSED TAB OR A RELOAD stops the drain at a pass boundary — the pass in
//     flight finishes server-side, so nothing is half-written, but nobody asks
//     for pass n+1. adopt() finds the ledger again on the next mount and the
//     page offers to continue.
//   • THE LEDGER survives both, for ten minutes after the run stops writing.
//     That is the server's TTL and it is why a finished run is still readable
//     when you wander back, and why it eventually stops being.
//   • NOTHING IS PERSISTED CLIENT-SIDE. There is no localStorage draft here,
//     unlike the BGG flow: the server already holds the only copy worth having,
//     and a second one would go stale the moment another tab ran a pass.

(function () {
  // The log turns over every second or two while a run is live.
  const POLL_MS = 1000;
  // The Settings card is five pills, not a log — it does not need that rate,
  // and it polls even when nothing is running so a run started elsewhere shows
  // up. GET /admin/runs is an in-process dict read, so this is cheap.
  const SUMMARY_POLL_MS = 5000;
  // Older than this with no write is a run nobody is driving any more. Longer
  // than the quietest stretch of a real pass: an images pass sleeps 1.5s per
  // game and writes a line each time, and a scan over a big catalog is a few
  // seconds. Same reasoning as STALL_TICKS in bgg-sync-flow.js.
  const STALE_AFTER_MS = 90 * 1000;
  // A drain is bounded so a bug in `remaining` cannot spin forever. Twenty-five
  // passes of 200 is 5000 games, comfortably past the catalog.
  const MAX_PASSES = 25;

  class AdminRunFlow {
    constructor() {
      /** @type {Object<string, any>} slug → the last snapshot we read */
      this.runs = {};
      /** @type {string|null} the tool THIS tab is driving, if any */
      this.driving = null;
      /** @type {Object<string, string>} slug → a client-side failure to show */
      this.errors = {};
      this.loaded = false;
      // Monotonic guard. Captured before every await and re-checked after, so
      // a pass the operator has already navigated past — or replaced by
      // pressing Run again — cannot publish over whatever replaced it.
      this._seq = 0;
      // adopt() gets its OWN counter, and that is load-bearing rather than
      // tidy. Sharing this._seq means every adopt bumps it — and adopt runs on
      // every mount of Settings and of the backfill spoke. So walking from the
      // run page to Settings mid-drain would fail the drain loop's own guard
      // on its next pass and stop a twenty-minute catalog fill, silently,
      // which is the exact thing this whole file exists to prevent. The two
      // are independent reads and must not be able to cancel each other.
      this._adoptSeq = 0;
      this._pollHandle = null;
      this._pollFn = null;
    }

    // ── The registry ─────────────────────────────────────────────────────────
    // Lives in domain/admin-run-tools.js; reached through here so the surfaces
    // have one handle rather than two.

    /** @param {string} slug */
    tool(slug) { return window.AdminRunTools.get(slug); }

    slugs() { return window.AdminRunTools.slugs(); }

    // ── Publishing ───────────────────────────────────────────────────────────

    /** @returns {any} A fresh object every time — Store.set() compares by ===. */
    snapshot() {
      return { runs: { ...this.runs }, driving: this.driving, errors: { ...this.errors }, loaded: this.loaded };
    }

    _publish() {
      if (window.store) window.store.set("adminRun", this.snapshot());
    }

    /**
     * What a surface should SAY about one tool, derived once here so the pill
     * on Settings and the footer on the run page cannot disagree.
     *
     * @param {string} slug
     * @returns {{state:string, stale:boolean, run:any, tool:any, error:string|null,
     *            live:boolean, resumable:boolean, label:string}}
     */
    stateOf(slug) {
      const tool = this.tool(slug);
      const run = this.runs[slug] || null;
      const error = this.errors[slug] || null;
      const raw = (run && run.state) || "unknown";
      const driving = this.driving === slug;

      // A ledger nobody has written to for a while is not a run in progress.
      // Only worth asking about a run THIS tab is not driving — while we are
      // the ones posting the passes, we know better than the clock does.
      const stale = raw === "running" && !driving && this._ageMs(run) > STALE_AFTER_MS;

      const state = stale ? "interrupted" : raw;
      const live = driving || state === "running";
      // Something left to do, and nothing doing it. Covers both ways a drain
      // stops early: a tab closed mid-pass (stale), and a pass that returned
      // `remaining` to a tab that then went away (done, but not finished).
      const totals = (run && run.totals) || null;
      const resumable = !live && !!totals && totals.remaining > 0;

      return { state, stale, run, tool, error, live, resumable, label: this._label(state, run, error) };
    }

    /** A snapshot's write time, as a number. 0 for anything unreadable, so an
     *  undated snapshot always loses to a dated one. */
    _stamp(run) {
      const t = run && run.updated_at ? Date.parse(run.updated_at) : NaN;
      return isNaN(t) ? 0 : t;
    }

    _ageMs(run) {
      if (!run || !run.updated_at) return Infinity;
      const t = Date.parse(run.updated_at);
      return isNaN(t) ? Infinity : Date.now() - t;
    }

    /** The pill's words. Short enough for a row, specific enough to be worth
     *  the space — "Running" alone tells an operator nothing they did not know. */
    _label(state, run, error) {
      if (error) return "Failed";
      if (state === "running") {
        const step = ((run && run.steps) || []).find((s) => s.state === "active");
        if (step && typeof step.total === "number" && step.total) {
          return `${step.done || 0} of ${step.total}`;
        }
        return "Running";
      }
      if (state === "interrupted") {
        const left = run && run.totals ? run.totals.remaining : 0;
        return left ? `Paused · ${left} left` : "Interrupted";
      }
      if (state === "failed") return "Failed";
      if (state === "done") {
        const t = (run && run.totals) || { updated: 0, failed: 0, remaining: 0 };
        if (t.remaining) return `Paused · ${t.remaining} left`;
        if (t.failed) return `Done · ${t.failed} failed`;
        return `Done · ${t.updated} updated`;
      }
      return "";
    }

    // ── Adoption ─────────────────────────────────────────────────────────────

    /**
     * Find runs this tab did not start.
     *
     * Called on every mount of a surface that shows a pill, which is what makes
     * a reload, a second tab, or an admin arriving after the fact all see the
     * run that is happening rather than an idle row. One request for every
     * tool, journals stripped — see admin_run_routes.py for why that is two
     * endpoints and not one.
     */
    async adopt() {
      const seq = ++this._adoptSeq;
      try {
        const rows = await window.api.get("/admin/runs");
        if (seq !== this._adoptSeq) return;
        const next = {};
        for (const row of rows || []) next[row.tool] = row;
        // Replaced wholesale rather than merged: a tool absent from the list
        // has expired, and keeping a ten-minute-old snapshot around would
        // leave a "Done" pill on a row whose log is already gone.
        //
        // The one thing carried over is a snapshot we hold that is NEWER than
        // the one that just arrived. Two reads feed this object — the summary
        // here and the run page's per-tool poll, which is faster and carries
        // the journal — and they interleave: a summary request in flight while
        // a pass lands comes back describing the run before it. Keeping the
        // newer of the two by `updated_at` means neither read can walk the
        // other backwards, and it is why the run page's log does not lose its
        // events the moment the Settings card ticks.
        for (const [slug, held] of Object.entries(this.runs)) {
          const incoming = next[slug];
          if (incoming && this._stamp(held) > this._stamp(incoming)) next[slug] = held;
        }
        this.runs = next;
        this.loaded = true;
        this._publish();
        this._armSummaryPoll();
      } catch (_) {
        // A failed adopt costs the pill, not the run. Anything actually
        // running is still running, and the next mount asks again.
        this.loaded = true;
        this._publish();
      }
    }

    /** The full ledger, journal included — only the run page needs this. */
    async _pollOne(slug) {
      const seq = this._seq;
      try {
        const run = await window.api.get(`/admin/runs/${encodeURIComponent(slug)}`);
        if (seq !== this._seq) return;
        // `unknown` means the ledger has expired. Drop the row rather than
        // pinning a stale one, so the page falls back to its idle state.
        if (run && run.state === "unknown") delete this.runs[slug];
        else this.runs[slug] = run;
        this._publish();
      } catch (_) {
        // One dropped poll is not worth telling anyone about; the next tick
        // asks again, and the POST is the thing that reports failure.
      }
    }

    // ── Running ──────────────────────────────────────────────────────────────

    /**
     * Start a run, or continue one that stopped.
     *
     * Safe to call when something is already going: a tool this tab is driving
     * is left alone, and a tool the SERVER says is live is watched rather than
     * started again — two drains against one ledger would interleave their
     * passes and double every BGG call.
     *
     * @param {string} slug
     * @param {{resume?: boolean}=} opts
     */
    async start(slug, opts) {
      const tool = this.tool(slug);
      if (!tool) return;
      const here = this.stateOf(slug);
      if (here.live) { this.watch(slug); return; }

      const resume = !!(opts && opts.resume);
      const seq = ++this._seq;
      this.driving = slug;
      delete this.errors[slug];
      // Optimistic, so the page flips to "running" in the same frame as the
      // tap rather than a poll interval later.
      this._publish();
      this._armRunPoll(slug);

      try {
        // A resume continues the ledger the last tab left; a fresh start opens
        // a new one. Pass 0 is what the server reads as "this is a new run".
        let pass = resume ? this._nextPass(slug) : 0;
        for (let n = 0; n < MAX_PASSES; n++) {
          const result = await tool.run({
            limit: tool.limit,
            passNo: pass,
            timeoutMs: tool.timeoutMs,
          }) || {};
          if (seq !== this._seq) return;
          if (!tool.multiPass || !result.remaining) break;
          pass += 1;
        }
      } catch (e) {
        if (seq !== this._seq) return;
        // The ledger records what the SERVER saw. This records what the
        // BROWSER saw, which is a different failure — a dropped connection
        // mid-pass leaves a perfectly healthy run with no one asking for the
        // next pass, and the page has to say so rather than showing the last
        // good checklist and nothing else.
        this.errors[slug] = (e && e.message) || "The run stopped reporting";
      } finally {
        if (seq === this._seq) {
          this.driving = null;
          // One last read so the final phase, the totals and the closing log
          // lines land even though the poll is about to stop.
          await this._pollOne(slug);
          if (seq === this._seq) {
            this._publish();
            this._armSummaryPoll();
          }
        }
      }
    }

    /** Resume a drain a closed tab left behind. */
    resume(slug) { return this.start(slug, { resume: true }); }

    /** The pass number a resume should ask for. Any non-zero value tells the
     *  server to continue rather than start over; using the real one keeps the
     *  log's pass breaks honest. */
    _nextPass(slug) {
      const run = this.runs[slug];
      const n = run && typeof run.pass_no === "number" ? run.pass_no : 0;
      return n + 1;
    }

    /** Watch a run this tab is not driving — the run page arriving mid-run. */
    watch(slug) {
      this._armRunPoll(slug);
      this._pollOne(slug);
    }

    // ── Polling ──────────────────────────────────────────────────────────────
    //
    // One handle, two modes. The run page wants one tool's whole log every
    // second; everything else wants five pills every five. A hidden tab skips
    // the fetch and catchUp() fires one tick on return — the DRAIN is never
    // suppressed, only the watching of it, because a background tab that
    // stopped asking for passes is exactly the bug this file exists to avoid.

    _armRunPoll(slug) {
      this._startPoll(POLL_MS, () => {
        if (document.hidden) return;
        this._pollOne(slug);
      });
    }

    _armSummaryPoll() {
      this._startPoll(SUMMARY_POLL_MS, () => {
        if (document.hidden) return;
        this.adopt();
      });
    }

    _startPoll(intervalMs, fn) {
      this._stopPoll();
      this._pollFn = fn;
      this._pollHandle = setInterval(fn, intervalMs);
    }

    _stopPoll() {
      if (this._pollHandle) {
        clearInterval(this._pollHandle);
        this._pollHandle = null;
      }
      this._pollFn = null;
    }

    /** Stop watching. NOT stop running — the drain loop is not on this timer,
     *  and a surface unmounting must not end a run. */
    stopWatching() {
      if (!this.driving) this._stopPoll();
    }

    /** One catch-up tick, for a surface's visibilitychange listener. */
    catchUp() {
      if (this._pollFn && !document.hidden) this._pollFn();
    }
  }

  window.AdminRunFlow = new AdminRunFlow();
})();
