// @ts-check
// domain/bgg-sync-flow.js — the BoardGameGeek comparison and both syncs, as one
// state machine that outlives every screen showing it.
//
// WHY THIS IS A DOMAIN OBJECT AND NOT VIEW STATE. The flow lives on a routed
// screen (views/bgg-sync-view.js), and router.go() unmounts the view you came
// from. If the run lived on either view, closing the screen would end the sync
// — which is exactly the thing the user is promised they can do. So the POSTs,
// the polls and the results live here, the two surfaces subscribe, and neither
// owns anything.
//
// The two surfaces:
//   • views/bgg-sync-view.js  the four screens
//   • views/settings-view.js  the one-row progress strip
//
// Both read snapshot() and re-render on the "bggSync" store key. Every publish
// is a NEW object because Store.set() early-returns on ===.
//
// WHAT SURVIVES WHAT, because it is not uniform and the copy depends on it:
//   • The two syncs are BackgroundTasks with DB queue state. They survive a
//     closed tab, a reload and a server restart; the poll picks them back up.
//   • The CHECK does not. build_plan is awaited inside the handler, so a reload
//     kills it and its result. That is why the checklist screen says "this
//     takes about 30 seconds" and never "keeps running in the background".
//   • The DIFF is saved to localStorage (see save/restore) so a reload on the
//     comparison screen does not cost another 40-second sweep.

(function () {
  const DRAFT_KEY = "bgb.bggSync.flow";
  // Bump when the stored shape changes. A stored flow at a different version is
  // discarded rather than half-restored — same rule as domain/play-import.js.
  const DRAFT_VERSION = 1;

  // A comparison describes a third-party account that moves underneath it.
  // Past this, restoring one would be offering to sync against a stale plan.
  const DIFF_MAX_AGE_MS = 5 * 60 * 1000;

  // The checklist polls faster than the queue polls: the check's phases turn
  // over in a couple of seconds each, where a queue drains one game per 1.5s.
  const CHECK_POLL_MS = 1000;
  const QUEUE_POLL_MS = 2000;

  // A wedged queue must not poll forever. Twenty ticks of no movement is ~40s
  // on a worker that manages one game every 1.5s — long past "slow".
  const STALL_TICKS = 20;

  /**
   * @typedef {"idle"|"checking"|"review"|"confirm"|"running"|"done"|"error"} FlowScreen
   */

  class BggSyncFlow {
    constructor() {
      this._reset();
      // Monotonic guard. Captured before every await and re-checked after, so
      // a POST the user has already navigated past cannot publish over
      // whatever they moved on to. Never reset — it only has to increase.
      this._seq = 0;
      this._pollHandle = null;
      this._stallTicks = 0;
      this._lastSettled = -1;
    }

    _reset() {
      /** @type {FlowScreen} */
      this.screen = "idle";
      /** @type {"push"|"pull"|null} */
      this.direction = null;
      /** @type {any} */
      this.diff = null;
      /** @type {any} */
      this.progress = null;      // GET /bgg/check/progress
      /** @type {any} */
      this.summary = null;       // POST /bgg/sync or /bgg/push
      /** @type {any} */
      this.status = null;        // GET /bgg/sync/status or /bgg/push/status
      /** @type {string|null} */
      this.error = null;
      this.checkedAt = null;
    }

    // ── Publishing ───────────────────────────────────────────────────────────

    /** @returns {any} A fresh object every time — Store.set() compares by ===. */
    snapshot() {
      return {
        screen: this.screen,
        direction: this.direction,
        diff: this.diff,
        progress: this.progress,
        summary: this.summary,
        status: this.status,
        error: this.error,
        checkedAt: this.checkedAt,
      };
    }

    _publish() {
      if (window.store) window.store.set("bggSync", this.snapshot());
    }

    /** True while anything is in flight — the Settings card disables on it. */
    isBusy() {
      return this.screen === "checking" || this.screen === "running";
    }

    /** True when the user is reviewing a 500-row table that must not repaint. */
    isStatic() {
      return this.screen === "confirm";
    }

    // ── The check ────────────────────────────────────────────────────────────

    /**
     * Start a comparison. Safe to call when one is already running — it is the
     * Settings button's handler, and a double-tap must not start two sweeps.
     */
    async start() {
      if (this.isBusy()) return;
      const seq = ++this._seq;
      this._stopPoll();
      this._reset();
      this.screen = "checking";
      this._publish();
      this._startPoll(CHECK_POLL_MS, () => this._tickCheck());

      let diff;
      try {
        diff = await window.Bgg.check();
      } catch (e) {
        if (seq !== this._seq) return;
        this._stopPoll();
        this.screen = "error";
        // A tripped deadline is not a failure of the comparison, but unlike a
        // sync there is nothing still running to point at: the result died
        // with the request. Say so, and offer the retry.
        this.error = (e && e.timeout)
          ? "BoardGameGeek is taking a while. Try again in a moment."
          : (e && e.message) || "Couldn't compare with BoardGameGeek";
        this._publish();
        return;
      }
      if (seq !== this._seq) return;
      this._stopPoll();
      this.diff = diff;
      this.checkedAt = diff && diff.checked_at ? diff.checked_at : new Date().toISOString();
      this.screen = "review";
      this._publish();
      this.save();

      // Games this check imported into the catalog land by name a little
      // later. Keep polling so the comparison can say when they have.
      if (diff && diff.catalog_pending) {
        await this._loadSyncStatus();
        if (!window.Bgg.catalogFillDrained(this.status)) {
          this._startPoll(QUEUE_POLL_MS, () => this._tickCatalog());
        }
      }
    }

    async _tickCheck() {
      if (document.hidden) return;
      let progress;
      try {
        progress = await window.Bgg.checkProgress();
      } catch (_) {
        return;   // A dropped poll is not a failed check.
      }
      // "unknown" means the server has no record — a restart, or a worker that
      // never ran this check. It does NOT mean finished: completion comes from
      // the POST above. Publish it and let the renderer say "still working".
      this.progress = progress;
      this._publish();
    }

    // ── Direction and confirm ────────────────────────────────────────────────

    /** @param {"push"|"pull"} direction */
    chooseDirection(direction) {
      if (!this.diff || this.isBusy()) return;
      this.direction = direction;
      this.screen = "confirm";
      this._publish();
    }

    backToReview() {
      if (this.screen !== "confirm") return;
      this.direction = null;
      this.screen = "review";
      this._publish();
    }

    /** Commit the direction the user reviewed. */
    async confirm() {
      if (this.screen !== "confirm" || !this.direction) return;
      const direction = this.direction;
      const seq = ++this._seq;
      this.screen = "running";
      this.summary = null;
      this.status = null;
      this.error = null;
      this.progress = null;
      this._publish();
      this.save();

      // A push normally commits the comparison the server still holds and
      // answers immediately; only when that has aged out does it re-sweep, and
      // then it is the same 10-40 seconds as a check. Arm the checklist either
      // way — it costs one poll on the fast path, and it is the difference
      // between a narrated wait and a blank screen on the slow one.
      if (direction === "push") {
        this._startPoll(CHECK_POLL_MS, () => this._tickCheck());
      }

      let summary;
      try {
        summary = direction === "push"
          ? await window.Bgg.push(this.checkedAt)
          : await window.Bgg.sync();
      } catch (e) {
        if (seq !== this._seq) return;
        this._stopPoll();
        // A tripped deadline here IS different from the check: the handler
        // queued the worker whether or not we were still listening, so the
        // run is alive and the poll below will find it.
        if (e && e.timeout) {
          this.error = null;
          await this._loadRunStatus();
          this._armRunPoll();
          return;
        }
        this.screen = "error";
        this.error = (e && e.message)
          || (direction === "push" ? "Push failed" : "Import failed");
        this._publish();
        return;
      }
      if (seq !== this._seq) return;
      this._stopPoll();
      this.summary = summary;
      // The comparison described the state before this run and cannot describe
      // the state after it, so it is spent. Dropping it here is what stops the
      // review screen offering a second commit against a stale plan.
      this.diff = null;
      this._publish();

      await this._loadRunStatus();
      this._armRunPoll();
    }

    _armRunPoll() {
      const drained = this.direction === "push"
        ? window.Bgg.pushDrained(this.status)
        : window.Bgg.importDrained(this.status);
      if (drained) {
        this._finishRun();
        return;
      }
      this._stallTicks = 0;
      this._lastSettled = -1;
      this._startPoll(QUEUE_POLL_MS, () => this._tickRun());
    }

    async _tickRun() {
      if (document.hidden) return;
      await this._loadRunStatus();
      const s = this.status || {};
      const settled = (s.session_done || 0) + (s.session_errored || 0);
      if (settled === this._lastSettled) {
        this._stallTicks += 1;
      } else {
        this._stallTicks = 0;
        this._lastSettled = settled;
      }
      const drained = this.direction === "push"
        ? window.Bgg.pushDrained(this.status)
        : window.Bgg.importDrained(this.status);
      if (drained) {
        this._finishRun();
        return;
      }
      if (this._stallTicks >= STALL_TICKS) {
        // Stop rather than poll a wedged queue forever. The run may still be
        // alive; reopening re-arms from the current counters.
        this._stopPoll();
        this.error = "Still working. Reopen this screen to check again.";
        this._publish();
        return;
      }
      this._publish();
    }

    _finishRun() {
      this._stopPoll();
      this.screen = "done";
      // Only an import writes local rows. A push changes nothing here, so
      // dropping the status map and the feed for one would be pure churn.
      if (this.direction === "pull") window.Bgg.invalidateImportedData();
      this._publish();
      this.save();
    }

    async _loadRunStatus() {
      try {
        this.status = this.direction === "push"
          ? await window.Bgg.pushStatus()
          : await window.Bgg.status();
      } catch (_) {
        // Non-fatal: the log renders from the summary until the next tick.
      }
      this._publish();
    }

    async _loadSyncStatus() {
      try {
        this.status = await window.Bgg.status();
      } catch (_) {}
      this._publish();
    }

    async _tickCatalog() {
      if (document.hidden) return;
      await this._loadSyncStatus();
      if (window.Bgg.catalogFillDrained(this.status)) {
        this._stopPoll();
        // The names have landed, so the comparison can print them now.
        window.Bgg.invalidateImportedData();
        this._publish();
      }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Re-arm after a reload or a return to Settings. Idempotent, and cheap
     * when there is nothing to resume.
     */
    async resume() {
      if (this._pollHandle) return;              // already live
      if (this.screen === "idle") this.restore();
      if (this.screen === "running") {
        await this._loadRunStatus();
        this._armRunPoll();
        return;
      }
      if (this.screen === "review" && this.diff && this.diff.catalog_pending) {
        await this._loadSyncStatus();
        if (!window.Bgg.catalogFillDrained(this.status)) {
          this._startPoll(QUEUE_POLL_MS, () => this._tickCatalog());
        }
      }
    }

    /** Clear everything and forget the saved draft. The close button's path. */
    reset() {
      this._seq += 1;
      this._stopPoll();
      this._reset();
      this.clearDraft();
      this._publish();
    }

    // ── Polling ──────────────────────────────────────────────────────────────
    //
    // One handle: the flow is a single sequential run, so there is never more
    // than one thing worth watching. A hidden tab skips the fetch and the
    // visibilitychange listener below fires one catch-up tick on return.

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

    /** One catch-up tick, for the visibilitychange listener wired in init. */
    catchUp() {
      if (this._pollFn && !document.hidden) this._pollFn();
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    save() {
      if (this.screen === "idle") { this.clearDraft(); return; }
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: DRAFT_VERSION,
          screen: this.screen,
          direction: this.direction,
          diff: this.diff,
          checkedAt: this.checkedAt,
          summary: this.summary,
          savedAt: Date.now(),
        }));
      } catch (_) {
        // A full or blocked quota costs the resume, not the sync.
      }
    }

    clearDraft() {
      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    }

    /** @returns {boolean} True when a usable flow was read back. */
    restore() {
      let raw = null;
      try { raw = localStorage.getItem(DRAFT_KEY); } catch (_) { return false; }
      if (!raw) return false;
      let data;
      try { data = JSON.parse(raw); } catch (_) { this.clearDraft(); return false; }
      if (!data || data.v !== DRAFT_VERSION) { this.clearDraft(); return false; }

      // A check that was mid-flight when the page went away is gone with it —
      // build_plan runs inside the request. Resuming into "checking" would
      // spin against a sweep nobody is running.
      if (data.screen === "checking" || data.screen === "error") {
        this.clearDraft();
        return false;
      }
      // A comparison older than DIFF_MAX_AGE_MS is not worth offering: it
      // describes a BoardGameGeek account that has had five minutes to move.
      const stale = !data.savedAt || (Date.now() - data.savedAt) > DIFF_MAX_AGE_MS;
      if (stale && data.screen !== "running") { this.clearDraft(); return false; }

      this.screen = data.screen;
      this.direction = data.direction || null;
      this.diff = data.diff || null;
      this.checkedAt = data.checkedAt || null;
      this.summary = data.summary || null;
      this.status = null;
      this.progress = null;
      this.error = null;
      // A run restored from storage has an unknown queue position until the
      // first poll answers; screen stays "running" and resume() re-arms.
      this._publish();
      return true;
    }
  }

  window.BggSyncFlow = new BggSyncFlow();
})();
