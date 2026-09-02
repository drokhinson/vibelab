// @ts-check
// views/bgg-sync-view.js — the BoardGameGeek comparison and both syncs, as one
// screen with four faces.
//
// Reached from Settings. Runs the comparison with a live checklist, shows what
// differs, confirms one direction against the full list, then narrates the run.
//
// The state lives in domain/bgg-sync-flow.js and the screen bodies in
// widgets/bgg-sync-screens.js; this file is the shell. It owns the chrome, the
// footer, and the transitions — nothing else.
//
// Three things worth knowing:
//
//   • NO STEP COUNTER. The importer's chrome pins "Step 3 of 6" and a segment
//     bar, and this deliberately does not: those four faces are not a
//     traversal. Most people will stop at the comparison, and a counter would
//     promise them two more screens they are never going to see.
//   • THE STATE IS NOT MINE. Everything survives this view being unmounted,
//     because router.go() unmounts it and the whole promise of the flow is
//     that a sync keeps running when you leave. render() is a pure function of
//     the flow's snapshot.
//   • THE CONFIRM SCREEN DOES NOT REPAINT. It can carry 500 table rows, and
//     the flow publishes nothing while it is up — but a blanket
//     listen -> render() would still repaint it on an unrelated tick, so the
//     guard is explicit in render().

(function () {
  class BggSyncView extends window.View {
    constructor() {
      super("bgg-sync");
      this._lastScreen = null;
    }

    /** @returns {any} */
    get flow() { return window.BggSyncFlow; }

    renderLoading() {
      // Synchronous, before onMount. restore() runs there and may land on any
      // screen, so painting the checklist here would flash the wrong one.
      const el = this.container;
      if (el) el.innerHTML = this._chrome(`
        <div class="bgg-flow__step bgg-flow__step--center">
          ${buddyLoader({ size: 96, label: "Opening…" })}
        </div>
      `, { hideNav: true });
    }

    async onMount() {
      this.listen("bggSync", () => this.render());
      // The flow keeps polling with the tab hidden suppressed; this fires the
      // one catch-up tick on return. Lives here rather than in the flow so it
      // unsubscribes with the view — Settings arms its own.
      this.listenDom("visibilitychange", () => {
        if (!document.hidden) this.flow.catchUp();
      });
      // Entering with nothing running means the user pressed Check status, so
      // start one. Entering mid-run means they tapped the Settings strip, so
      // pick up where it got to.
      if (this.flow.screen === "idle") {
        this.flow.start();
      } else {
        await this.flow.resume();
      }
    }

    async onUnmount() {
      // Save rather than clear: leaving is not abandoning, and the close
      // button is the path that clears (see close()).
      this.flow.save();
    }

    // ── Chrome ───────────────────────────────────────────────────────────────

    _chrome(body, opts) {
      const o = opts || {};
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" type="button" aria-label="Back to settings"
                  onclick="window.bggSyncView.back()">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">BoardGameGeek</h2>
        </header>
        <div class="bgg-flow__body">${body}</div>
        ${o.hideNav ? "" : this._renderNav()}
      `;
    }

    _renderNav() {
      const snap = this.flow.snapshot();
      switch (snap.screen) {
        case "checking":
          // Nothing to press. The only affordance is leaving, which the back
          // arrow already provides — and unlike a sync, a check does not
          // survive the tab, so there is no "keeps running" to promise.
          return "";
        case "review":
          return `<div class="bgg-flow__nav">
            <button class="bgg-flow__nav-back" type="button"
                    onclick="window.bggSyncView.close()">Close</button>
          </div>`;
        case "confirm": {
          const { label, actionable } = window.BggSyncScreens.commitLabel(snap);
          return `<div class="bgg-flow__nav">
            <button class="bgg-flow__nav-back" type="button"
                    onclick="window.bggSyncView.backToReview()">Back</button>
            <button class="bgg-flow__nav-next" type="button" ${actionable ? "" : "disabled"}
                    onclick="window.bggSyncView.confirm()">${escapeHtml(label)}</button>
          </div>`;
        }
        case "running":
          return `<div class="bgg-flow__nav">
            <button class="bgg-flow__nav-back" type="button"
                    onclick="window.bggSyncView.close()">Close</button>
          </div>`;
        case "done":
          return `<div class="bgg-flow__nav">
            <button class="bgg-flow__nav-next" type="button"
                    onclick="window.bggSyncView.finish()">Done</button>
          </div>`;
        case "error":
          return `<div class="bgg-flow__nav">
            <button class="bgg-flow__nav-back" type="button"
                    onclick="window.bggSyncView.close()">Close</button>
            <button class="bgg-flow__nav-next" type="button"
                    onclick="window.bggSyncView.recheck()">Try again</button>
          </div>`;
        default:
          return "";
      }
    }

    render() {
      const el = this.container;
      if (!el) return;
      const snap = this.flow.snapshot();

      // The confirm screen is static by contract — see the header. Repainting
      // a 500-row table on a poll tick is visible jank, so a tick that arrives
      // while it is up is dropped unless the screen itself changed.
      if (snap.screen === "confirm" && this._lastScreen === "confirm") return;
      this._lastScreen = snap.screen;

      const body = window.BggSyncScreens[snap.screen];
      el.innerHTML = this._chrome(
        body ? body(snap) : "",
        { hideNav: snap.screen === "idle" },
      );
      this.refreshIcons();
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /** @param {"push"|"pull"} direction */
    choose(direction) { this.flow.chooseDirection(direction); }

    backToReview() { this.flow.backToReview(); }

    confirm() { this.flow.confirm(); }

    recheck() { this.flow.start(); }

    /** The back arrow: leave, keep whatever is running running. */
    back() { window.router.up("settings"); }

    /** Close: same, and the flow's save() on unmount keeps the comparison. */
    close() { window.router.up("settings"); }

    /** Done on a finished run: the comparison is spent, so clear it out. */
    finish() {
      this.flow.reset();
      window.router.up("settings");
    }
  }

  window.BggSyncView = BggSyncView;
})();
