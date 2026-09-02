// widgets/admin-backfill-panel.js — one "catalog rows missing X" admin panel.
//
// Extracted at instance #2 (ui-object-design.md §4): the images panel and the
// descriptions panel are identical in lifecycle AND appearance, so the config
// carries the handful of strings that differ rather than each caller keeping
// its own markup. Reuses the .admin-reports__* class family wholesale — this
// widget ships no CSS of its own.
//
// The host view owns the repaint: every state change calls opts.render(), and
// the panel's html() is re-read from the host's own render pass.

(function () {
  // A bulk pass is bounded server-side, so a cold catalog needs several. Cap
  // the drain so a bug in `remaining` can't spin forever.
  const MAX_BULK_PASSES = 25;

  class AdminBackfillPanel {
    /**
     * @param {Object} opts
     * @param {string}   opts.key          stable id, used by the host's onclick delegators
     * @param {string}   opts.title        panel heading
     * @param {string}   opts.icon         data-icon name for the heading
     * @param {string}   opts.emptyText    shown when nothing is missing
     * @param {string}   opts.bulkLabel    label for the bulk button
     * @param {string}   opts.busyLabel    label while a refresh is running
     * @param {(n:number)=>string} opts.bulkConfirm   window.confirm copy
     * @param {(g:Object)=>string} opts.rowStatus     per-row "what's missing" label
     * @param {()=>Promise<Object[]>}  opts.list
     * @param {(id:string)=>Promise<any>} opts.refreshOne
     * @param {()=>Promise<{updated:number, remaining?:number, failed?:number}>} opts.refreshAll
     * @param {string}   opts.oneOkToast   toast after a single-row refresh
     * @param {()=>void} opts.render       host repaint
     */
    constructor(opts) {
      this.opts = opts;
      this.key = opts.key;
      this._rows = [];
      this._loading = false;
      this._busyId = null;   // id of the row currently refreshing
      this._bulk = false;
      this._bulkNote = "";   // running progress during a multi-pass drain
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

    async refreshAll() {
      const count = this._rows.length;
      if (!window.confirm(this.opts.bulkConfirm(count))) return;
      this._bulk = true;
      this._bulkNote = "";
      this.opts.render();
      let updated = 0;
      let failed = 0;
      try {
        // Drain: one pass is bounded server-side, so keep going while the
        // server still reports work left. `remaining` is absent on the images
        // endpoint, which does the whole catalog in one pass — undefined is
        // falsy, so that path runs exactly once.
        for (let pass = 0; pass < MAX_BULK_PASSES; pass++) {
          const result = (await this.opts.refreshAll()) || {};
          updated += result.updated || 0;
          failed += result.failed || 0;
          if (!result.remaining) break;
          this._bulkNote = `${updated} done, ${result.remaining} left`;
          this.opts.render();
        }
        const plural = updated === 1 ? "" : "s";
        showToast(
          failed
            ? `Updated ${updated} game${plural}, ${failed} failed`
            : `Updated ${updated} game${plural}`,
          failed ? "warning" : "success",
        );
        await this.load();
      } catch (e) {
        showToast(e.message || "Bulk refresh failed", "error");
      } finally {
        this._bulk = false;
        this._bulkNote = "";
        this.opts.render();
      }
    }

    html() {
      const o = this.opts;
      const bulkDisabled = this._bulk || this._loading;
      return `
        <div class="admin-reports__header">
          <h3 class="font-semibold flex items-center gap-2">
            <i data-icon="${o.icon}" class="w-4 h-4"></i>
            ${escapeHtml(o.title)}
            ${this._loading ? "" : `<span class="opacity-60 font-normal text-sm">(${this._rows.length})</span>`}
          </h3>
          <button class="btn btn-xs ${bulkDisabled ? "btn-ghost" : "btn-primary"}"
                  ${bulkDisabled ? "disabled" : ""}
                  onclick="window.adminView._panelAll('${o.key}')">
            ${this._bulk
              ? `<span class="loading loading-spinner loading-xs"></span> ${escapeHtml(this._bulkNote || o.busyLabel)}`
              : `<i data-icon="refresh-cw" class="w-3.5 h-3.5"></i> ${escapeHtml(o.bulkLabel)}`}
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
      const disabled = busy || !g.bgg_id || this._bulk;
      return `
        <li class="admin-reports__row">
          <div class="admin-reports__meta">
            <span class="admin-reports__game">${escapeHtml(g.name)}</span>
            ${g.bgg_id
              ? `<span class="admin-reports__type">BGG ${g.bgg_id}</span>`
              : `<span class="admin-reports__type">no bgg_id</span>`}
            ${g.year_published ? `<span class="admin-reports__date">${g.year_published}</span>` : ""}
          </div>
          <div class="admin-reports__preview">${escapeHtml(this.opts.rowStatus(g))}</div>
          <div class="admin-reports__footer">
            <span class="admin-reports__reporter">${g.bgg_id ? "" : "No BGG id — refresh disabled."}</span>
            <div class="admin-reports__actions">
              <button class="btn btn-xs ${disabled ? "btn-ghost" : "btn-primary"}"
                      ${disabled ? "disabled" : ""}
                      onclick="window.adminView._panelOne('${this.opts.key}', '${g.id}')">
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
