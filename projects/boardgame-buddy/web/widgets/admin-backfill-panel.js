// widgets/admin-backfill-panel.js — one "catalog rows missing X" admin panel.
//
// Extracted at instance #2 (ui-object-design.md §4): the images panel and the
// descriptions panel are identical in lifecycle AND appearance, so the config
// carries the handful of strings that differ rather than each caller keeping
// its own markup. Reuses the .admin-reports__* class family wholesale — this
// widget ships no CSS of its own.
//
// The host view owns the repaint: every state change calls opts.render(), and
// the panel's html() is re-read from the host's own render pass. Inline
// onclick attributes name `window.<opts.host>` AND carry the panel's `key`,
// because one spoke now stacks every backfill panel: the host has to know
// which of them a tap belongs to before it can delegate.

(function () {
  class AdminBackfillPanel {
    /**
     * @param {Object} opts
     * @param {string}   opts.key          stable id, used by the host's onclick delegators
     * @param {string}   opts.title        panel heading
     * @param {string}   opts.icon         data-icon name for the heading
     * @param {string}   opts.emptyText    shown when nothing is missing
     * @param {string}   opts.bulkLabel    label for the bulk button
     * @param {string}   opts.runTool      the admin-run slug this panel drives
     * @param {(n:number)=>string} opts.bulkConfirm   the confirm dialog's title
     * @param {(g:Object)=>string} opts.rowStatus     per-row "what's missing" label
     * @param {()=>Promise<Object[]>}  opts.list
     * @param {(id:string)=>Promise<any>} opts.refreshOne
     * @param {string}   opts.oneOkToast   toast after a single-row refresh
     * @param {string}   opts.host         the `window.<name>` of the hosting view
     * @param {()=>void} opts.render       host repaint
     */
    constructor(opts) {
      this.opts = opts;
      this.key = opts.key;
      this._rows = [];
      this._loading = false;
      this._busyId = null;   // id of the row currently refreshing
    }

    /** What the bulk run for this panel is doing, if anything. Read fresh on
     *  every paint rather than held: the flow outlives this widget, and a run
     *  can start, advance and finish while this panel is not even mounted. */
    get run() {
      return window.AdminRunFlow ? window.AdminRunFlow.stateOf(this.opts.runTool) : null;
    }

    async load() {
      this._loading = true;
      this.opts.render();
      try {
        const rows = await this.opts.list();
        this._rows = Array.isArray(rows) ? rows : [];
      } catch (e) {
        showToast(e.message || `Failed to load ${this.opts.title.toLowerCase()}`, "error");
        this._rows = [];
      } finally {
        this._loading = false;
        this.opts.render();
      }
    }

    async refreshOne(gameId) {
      this._busyId = gameId;
      this.opts.render();
      try {
        await this.opts.refreshOne(gameId);
        showToast(this.opts.oneOkToast, "success");
        // Drop the row optimistically so the user sees progress without
        // waiting for the missing-rows query to round-trip again.
        this._rows = this._rows.filter((g) => g.id !== gameId);
      } catch (e) {
        showToast(e.message || "Refresh failed", "error");
      } finally {
        this._busyId = null;
        this.opts.render();
      }
    }

    /**
     * Hand the whole queue to the run page.
     *
     * This used to BE the drain — a loop of up to 25 bounded passes, reporting
     * "40 done, 260 left" inside this button between them, for a run that can
     * take twenty minutes. Two things were wrong with that. The loop lived on
     * a widget, so leaving the screen killed it; and a button is not somewhere
     * you can show which game failed and why, which on a long catalog fill is
     * the only thing worth knowing. Both live on /admin/run/:tool now, and the
     * loop with them (domain/admin-run-flow.js).
     *
     * The confirm stays here, before the navigation: it is a real cost — every
     * pass calls BoardGameGeek once per batch — and the page that would ask
     * instead is the page that shows Run now, which is one tap too late.
     */
    async goToRun() {
      const st = this.run;
      // Already going: no confirm, nothing to start, just take them to it.
      if (st && st.state !== "unknown") {
        window.router.go("admin-run", { tool: this.opts.runTool });
        return;
      }
      const ok = await window.PolaroidPopup.confirm({
        title: this.opts.bulkConfirm(this._rows.length),
        confirmLabel: "Refresh all",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      window.router.go("admin-run", { tool: this.opts.runTool });
    }

    html() {
      const o = this.opts;
      const st = this.run;
      const live = !!(st && st.state !== "unknown");
      // While a run exists the button reports it and opens its log, rather
      // than offering to start a second one against the same ledger. It is
      // never disabled: "go and look at what is happening" is always a
      // reasonable thing to let someone do.
      const face = live
        ? `<i data-icon="${st.live ? "loader-2" : st.state === "done" ? "check" : "alert-triangle"}"
              class="w-3.5 h-3.5${st.live ? " animate-spin" : ""}"></i> ${escapeHtml(st.label)}`
        : `<i data-icon="refresh-cw" class="w-3.5 h-3.5"></i> ${escapeHtml(o.bulkLabel)}`;
      return `
        <div class="admin-reports__header">
          <h3 class="font-semibold flex items-center gap-2">
            <i data-icon="${o.icon}" class="w-4 h-4"></i>
            ${escapeHtml(o.title)}
            ${this._loading ? "" : `<span class="opacity-60 font-normal text-sm">(${this._rows.length})</span>`}
          </h3>
          <button class="btn btn-xs ${live && !st.live ? "btn-ghost" : "btn-primary"}"
                  onclick="window.${o.host}._all('${o.key}')">
            ${face}
          </button>
        </div>
        ${this._body()}
      `;
    }

    _body() {
      if (this._loading && this._rows.length === 0) {
        return window.buddyLoader({ size: 64 });
      }
      if (this._rows.length === 0) {
        return `<div class="text-sm opacity-60 p-6 text-center">${escapeHtml(this.opts.emptyText)}</div>`;
      }
      return `
        <ul class="admin-reports__list">
          ${this._rows.map((g) => this._row(g)).join("")}
        </ul>
      `;
    }

    _row(g) {
      const busy = this._busyId === g.id;
      const disabled = busy || !g.bgg_id;
      return `
        <li class="admin-reports__row">
          <div class="admin-reports__meta">
            <span class="admin-reports__game">${escapeHtml(g.name)}</span>
            ${g.bgg_id
              ? `<span>BGG ${g.bgg_id}</span>`
              : `<span>no bgg_id</span>`}
            ${g.year_published ? `<span>${g.year_published}</span>` : ""}
          </div>
          <div class="admin-reports__preview">${escapeHtml(this.opts.rowStatus(g))}</div>
          <div class="admin-reports__footer">
            <span>${g.bgg_id ? "" : "No BGG id — refresh disabled."}</span>
            <div class="admin-reports__actions">
              <button class="btn btn-xs ${disabled ? "btn-ghost" : "btn-primary"}"
                      ${disabled ? "disabled" : ""}
                      onclick="window.${this.opts.host}._one('${this.key}', '${g.id}')">
                ${busy
                  ? `<span class="loading loading-spinner loading-xs"></span> Refreshing…`
                  : `<i data-icon="refresh-cw" class="w-3.5 h-3.5"></i> Refresh`}
              </button>
            </div>
          </div>
        </li>
      `;
    }
  }

  window.AdminBackfillPanel = AdminBackfillPanel;
})();
