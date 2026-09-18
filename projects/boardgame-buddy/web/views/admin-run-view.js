// @ts-check
// views/admin-run-view.js — one admin catalog run, narrated.
//
// ONE screen, THREE tools. They are the same errand — "go and do slow throttled
// work against BoardGameGeek, and tell me what happened" — so the tool is a
// route param, not three views (ui-object-design.md §2). Everything that
// differs between them is a row in domain/admin-run-tools.js.
//
// This file is the SHELL: the gate, the header, the footer, and which of four
// faces to paint. The state is domain/admin-run-flow.js and the body is
// ui/admin-run-log.js — same three-way split as views/bgg-sync-view.js, and
// for the same reason: leaving this screen must not stop the run, so the run
// cannot live here.
//
// THE FOUR FACES, because the difference between two of them is the whole
// point of the page:
//   idle          nothing has run in the last ten minutes. Offer to start.
//   running       a pass is in flight — here or in another tab. Watch it.
//   interrupted   the ledger says work is left and nobody is doing it. This is
//                 what a closed tab mid-drain looks like on the way back, and
//                 it must NOT read as either "running" or "finished".
//   finished      done or failed, with the log still readable until it expires.

(function () {
  class AdminRunView extends window.View {
    constructor() {
      super("admin-run");
      this._slug = null;
      // Which of the four faces is currently painted. Drives the
      // surgical-vs-full repaint decision in render(), and is reset on every
      // mount because this view is a singleton and survives being routed away
      // from (.claude/rules/web-frontend.md, "Reset transient state").
      this._lastFace = null;
    }

    /** @returns {any} */
    get flow() { return window.AdminRunFlow; }

    /** The tool this mount is about. Read from route params, never from a
     *  field left over from the last mount — this view is a singleton and
     *  survives being routed away from (web-frontend.md, "Reset transient
     *  state on every mount of a reused view"). */
    _slugOf(params) {
      const slug = (params && params.tool) || null;
      return slug && this.flow.tool(slug) ? slug : null;
    }

    renderLoading() {
      // Synchronous, before onMount. adopt() runs there and may land on any
      // face, so painting one here would flash the wrong one.
      this._slug = this._slugOf(this.params);
      this._lastFace = null;
      const el = this.container;
      if (!el) return;
      // Gated here as well as in render(): this paints BEFORE onMount, so a
      // non-admin who deep-links the url would otherwise get a flash of admin
      // chrome and a title naming a tool they may not know exists.
      if (window.AdminGate.block(this)) return;
      const tool = this._slug ? this.flow.tool(this._slug) : null;
      el.innerHTML = this._chrome(
        `<div class="bgg-flow__step bgg-flow__step--center">
           ${buddyLoader({ size: 96, label: "Opening…" })}
         </div>`,
        tool ? tool.title : "Admin run",
        "",
      );
    }

    async onMount() {
      if (!window.AdminGate.allowed()) return;
      this._slug = this._slugOf(this.params);
      this.listen("adminRun", () => this.render());
      // The flow keeps polling with the tab hidden suppressed; this fires the
      // one catch-up tick on return. Lives here rather than in the flow so it
      // unsubscribes with the view — Settings arms its own.
      this.listenDom("visibilitychange", () => {
        if (!document.hidden) this.flow.catchUp();
      });
      // ADOPT BEFORE OFFERING. Arriving at a run that is already going — from
      // the Settings pill, from a second tab, after a reload — must watch it,
      // not start a second drain against the same ledger.
      await this.flow.adopt();
      if (this._slug && this.flow.stateOf(this._slug).live) this.flow.watch(this._slug);
    }

    /**
     * Re-routed to this screen with a different tool while already mounted —
     * a Settings pill tapped from the run page's own back stack, say.
     * View#mount() takes this branch instead of calling onMount again, so
     * without it the screen keeps painting the tool it opened with while the
     * address bar says otherwise.
     */
    async onParamsChange(params) {
      const next = this._slugOf(params);
      if (next === this._slug) return;
      this._slug = next;
      this._lastFace = null;
      await this.flow.adopt();
      if (this._slug && this.flow.stateOf(this._slug).live) this.flow.watch(this._slug);
      this.render();
    }

    async onUnmount() {
      // Stop WATCHING, not stop running: the drain loop is not on the poll
      // timer, and walking to the Feed mid-run is the case this whole file is
      // arranged around.
      this.flow.stopWatching();
    }

    // ── Chrome ───────────────────────────────────────────────────────────────

    _chrome(body, title, nav) {
      return `
        ${window.AdminGate.head(title)}
        <div class="bgg-flow__body" id="admin-run-body">${body}</div>
        <div id="admin-run-nav">${nav || ""}</div>
      `;
    }

    _renderNav(st) {
      const go = (fn) => `window.adminRunView.${fn}()`;
      if (st.live) {
        // No stop button, deliberately: a pass is a bounded server-side
        // transaction and there is nothing safe to interrupt mid-way. Close
        // says what leaving actually does, which is nothing to the run.
        return `<div class="bgg-flow__nav">
          <button class="bgg-flow__nav-back" type="button" onclick="${go("close")}">Close</button>
        </div>`;
      }
      if (st.resumable) {
        const left = st.run && st.run.totals ? st.run.totals.remaining : 0;
        return `<div class="bgg-flow__nav">
          <button class="bgg-flow__nav-back" type="button" onclick="${go("close")}">Close</button>
          <button class="bgg-flow__nav-next" type="button" onclick="${go("resume")}">
            Continue — ${left} left
          </button>
        </div>`;
      }
      if (st.state === "unknown") {
        return `<div class="bgg-flow__nav">
          <button class="bgg-flow__nav-next" type="button" onclick="${go("start")}">Sync now</button>
        </div>`;
      }
      return `<div class="bgg-flow__nav">
        <button class="bgg-flow__nav-back" type="button" onclick="${go("close")}">Close</button>
        <button class="bgg-flow__nav-next" type="button" onclick="${go("start")}">Sync again</button>
      </div>`;
    }

    /** The idle face. Not an empty state — nothing has gone wrong and there is
     *  nothing missing; the page is simply waiting to be told to go.
     *
     *  Reached by opening the run page directly. Coming from a panel's Sync now
     *  the run is already started before this could paint, which is why there
     *  is no longer a paragraph here explaining that you may leave and come
     *  back: the pill on the way out says it better than a sentence nobody
     *  reads twice. */
    _renderIdle(tool) {
      return `
        <div class="bgg-flow__step">
          <h3 class="bgg-flow__title font-display">${escapeHtml(tool.title)}</h3>
          <p class="bgg-flow__lede">${escapeHtml(tool.lede)}</p>
        </div>
      `;
    }

    _renderRun(st) {
      const tool = st.tool;
      const who = st.run && st.run.started_by
        ? `<p class="bgg-flow__note">Started by ${escapeHtml(st.run.started_by)}.</p>`
        : "";
      // The browser's own failure, which is NOT the ledger's: a dropped
      // connection leaves a healthy run with nobody asking for the next pass,
      // and the last good checklist alone would read as success.
      const clientError = st.error
        ? `<p class="bgg-log__errors">${escapeHtml(st.error)}</p>`
        : "";
      return `
        ${who}
        ${window.renderAdminRunLog(st.run, {
          labels: tool.labels,
          order: tool.order,
          stale: st.stale,
          className: "bgg-log--screen",
        })}
        ${clientError}
      `;
    }

    render() {
      if (window.AdminGate.block(this)) return;
      const el = this.container;
      if (!el) return;

      const slug = this._slug;
      const tool = slug ? this.flow.tool(slug) : null;
      if (!tool) {
        // A slug the registry does not know — a stale bookmark from before a
        // tool was renamed. Say so rather than painting an empty checklist.
        el.innerHTML = this._chrome(
          `<div class="bgg-flow__step">
             <p class="bgg-flow__lede">That admin tool no longer exists.</p>
           </div>`,
          "Admin run",
          `<div class="bgg-flow__nav">
             <button class="bgg-flow__nav-back" type="button"
                     onclick="window.router.back('settings')">Back to settings</button>
           </div>`,
        );
        this.refreshIcons();
        return;
      }

      const st = this.flow.stateOf(slug);
      const body = st.state === "unknown" ? this._renderIdle(tool) : this._renderRun(st);
      const nav = this._renderNav(st);

      // SURGICAL, because this repaints every second for as long as a run
      // lasts. Rebuilding the whole screen on each tick is the "it keeps
      // reloading" feel the rules warn about even when the data is right
      // (.claude/rules/web-frontend.md, Mutations feel instantaneous) — it
      // destroys the control under the user's finger before :active can land,
      // and it drops the log's scroller back to the top on every line.
      const host = el.querySelector("#admin-run-body");
      if (host && this._lastFace === st.state) {
        const keep = this._journalScroll(host);
        host.innerHTML = body;
        this._restoreJournalScroll(host, keep);
        this.refreshIcons(host);
        const navHost = el.querySelector("#admin-run-nav");
        // The footer changes only when the face does, so patch it separately
        // and leave the buttons — and their focus ring — alone in between.
        if (navHost && navHost.dataset.face !== st.state) {
          navHost.innerHTML = nav;
          navHost.dataset.face = st.state;
          this.refreshIcons(navHost);
        }
        return;
      }

      this._lastFace = st.state;
      el.innerHTML = this._chrome(body, tool.title, nav);
      const navHost = el.querySelector("#admin-run-nav");
      if (navHost) navHost.dataset.face = st.state;
      this.refreshIcons();
      // A face change usually means the log just appeared. Land on the newest
      // line rather than the oldest.
      const fresh = el.querySelector(".admin-run__lines");
      if (fresh) fresh.scrollTop = fresh.scrollHeight;
    }

    /**
     * Where the log was, and whether it was at the bottom.
     *
     * Pinned-to-bottom is remembered as a FLAG rather than a number, because
     * the number is about to change: the repaint is adding lines, so restoring
     * the old scrollTop would leave a reader who was watching the live tail
     * one line further behind on every tick. Someone who has scrolled up to
     * read something is left exactly where they were.
     */
    _journalScroll(host) {
      const list = host.querySelector(".admin-run__lines");
      if (!list) return null;
      const slack = list.scrollHeight - list.scrollTop - list.clientHeight;
      return { top: list.scrollTop, pinned: slack < 24 };
    }

    _restoreJournalScroll(host, keep) {
      if (!keep) return;
      const list = host.querySelector(".admin-run__lines");
      if (!list) return;
      list.scrollTop = keep.pinned ? list.scrollHeight : keep.top;
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    start() { if (this._slug) this.flow.start(this._slug); }

    resume() { if (this._slug) this.flow.resume(this._slug); }

    /** Leave, and leave whatever is running running. */
    close() { window.router.back("settings"); }
  }

  window.AdminRunView = AdminRunView;
})();
