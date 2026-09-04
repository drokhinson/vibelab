// @ts-check
// widgets/export-data-sheet.js — "take your data with you", as a bottom sheet.
//
// Opened from the Export row in Settings → Data management. Lists everything
// the account holds, each with its live row count from GET /export/manifest,
// and hands the ticked set to GET /export, which answers with a zip of CSVs.
//
// The counts are the reason this is a sheet rather than a single Export
// button. "Reference guides" is an abstract noun; "Reference guides · 0" is an
// answer, and it saves somebody downloading an archive to find out there is
// nothing in it. They are also why the sheet fetches before it can be
// committed — the
// panel opens immediately with a loading list, per the loading/empty/error
// rule in .claude/rules/web-frontend.md.
//
// The shell is ui/bottom-sheet.js (which owns Escape, the backdrop tap and the
// device back gesture) and the panel chrome is the shared .bgb-sheet__* family;
// only .export-sheet__* is ours.

(function () {
  // One per ExportDataset value on the backend. A dataset the server adds
  // later and this map has not caught up with still renders — it falls back to
  // the neutral glyph rather than an empty box, which is the same rule
  // .claude/rules/web-frontend.md states for db-sourced icon names.
  const ICONS = {
    collection: "library-big",
    plays: "dices",
    plays_detail: "layers",
    guides: "book-open",
  };
  const FALLBACK_ICON = "table";

  const LIST_ID = "bgb-export-list";
  const FOOT_ID = "bgb-export-foot";

  class ExportDataSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-export-data-sheet",
        className: "export-sheet",
        label: "Export your data",
      });
      this._reset();
    }

    _reset() {
      /** @type {Array<any>|null} */
      this._datasets = null;
      this._loading = false;
      this._error = null;
      /** @type {Set<string>} */
      this._picked = new Set();
      // True from the tap on Export until the archive is in the user's hands.
      // The sheet stays open throughout: this is the one action here that can
      // take ten seconds, and closing on the tap would leave somebody watching
      // a Settings screen with no idea whether anything is happening.
      this._busy = false;
      // Monotonic across the instance, bumped here rather than zeroed: every
      // reopen invalidates whatever the last one left in flight. A manifest
      // fetch or an export that lands after the user has closed and reopened
      // the sheet must not paint into — or dismiss — the sheet they are
      // looking at now.
      this._seq = (this._seq || 0) + 1;
    }

    /** @param {{returnFocus?: Element|null}} [opts] */
    open(opts = {}) {
      this._reset();
      this._loading = true;
      this._sheet.open({
        html: this._renderPanel(),
        label: "Export your data",
        returnFocus: opts.returnFocus || document.activeElement,
        onClick: (e) => this._onClick(e),
        onOpen: (root) => {
          // Not a row: the list is still a spinner when this runs. The panel
          // takes it so a screen reader reads the dialog's label, and the
          // first row gets it once the manifest lands (see _repaintList).
          const panel = root.querySelector(".bgb-sheet__panel");
          if (panel && /** @type {any} */ (panel).focus) /** @type {any} */ (panel).focus();
        },
      });
      this._load();
    }

    dismiss() {
      this._sheet.close();
    }

    async _load() {
      const seq = this._seq;
      try {
        const res = await window.api.get("/export/manifest");
        if (seq !== this._seq || !this._sheet.isOpen) return;
        this._datasets = (res && res.datasets) || [];
        this._error = null;
        // Everything you actually have, pre-ticked. The common case is "give
        // me all of it", and a sheet that opens with nothing selected makes
        // that four taps; an empty dataset stays unticked so the default
        // never produces a file that is only a header row.
        this._picked = new Set(
          this._datasets.filter((d) => (d.row_count || 0) > 0).map((d) => d.id),
        );
      } catch (e) {
        if (seq !== this._seq || !this._sheet.isOpen) return;
        this._datasets = null;
        this._error = (e && e.message) || "Couldn't load what's exportable.";
      }
      this._loading = false;
      this._repaintList();
      this._repaintFoot();
    }

    // ── Render ──────────────────────────────────────────────────────────────

    _renderPanel() {
      return `
        <div class="bgb-sheet__panel" tabindex="-1">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Export your data</h3>
          <p class="bgb-sheet__sub">
            Tick what to include. You'll get a .zip with one CSV per thing.
          </p>
          <div class="bgb-sheet__list" role="group" aria-label="What to export"
               id="${LIST_ID}">${this._renderList()}</div>
          <div class="bgb-sheet__foot" id="${FOOT_ID}">${this._renderFoot()}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>`;
    }

    _renderList() {
      if (this._loading) {
        return `<p class="bgb-sheet__empty">Checking what you have…</p>`;
      }
      if (this._error) {
        return `
          <p class="bgb-sheet__empty export-sheet__error">${escapeHtml(this._error)}</p>
          <button class="btn btn-ghost btn-sm export-sheet__retry" type="button"
                  data-export-action="retry">
            <i data-icon="refresh-cw" class="w-4 h-4"></i> Try again
          </button>`;
      }
      const rows = this._datasets || [];
      if (!rows.length) return `<p class="bgb-sheet__empty">Nothing to export yet.</p>`;
      return rows.map((d) => this._renderRow(d)).join("");
    }

    _renderRow(d) {
      const on = this._picked.has(d.id);
      const icon = ICONS[d.id] || FALLBACK_ICON;
      const count = Number(d.row_count) || 0;
      return `
        <button class="bgb-sheet__opt export-sheet__row" type="button" role="checkbox"
                aria-checked="${on ? "true" : "false"}"
                ${this._busy ? "disabled" : ""}
                data-export-pick="${escapeAttr(d.id)}">
          <i data-icon="${escapeAttr(icon)}" class="w-5 h-5"></i>
          <span class="bgb-sheet__opt-label">
            ${escapeHtml(d.label || d.id)}
            <span class="bgb-sheet__opt-sub">${escapeHtml(d.blurb || "")}</span>
          </span>
          <span class="bgb-sheet__opt-count">${count}</span>
          <span class="bgb-sheet__tick" aria-hidden="true">
            <i data-icon="check" class="w-3 h-3"></i>
          </span>
        </button>`;
    }

    _renderFoot() {
      if (this._loading || this._error || !this._datasets) return "";
      const n = this._picked.size;
      const label = this._busy
        ? "Preparing your zip…"
        : n
          ? `Export ${n} ${n === 1 ? "thing" : "things"}`
          : "Pick something to export";
      return `
        <button class="bgb-sheet__confirm" type="button" data-export-action="go"
                ${!n || this._busy ? "disabled" : ""}>
          ${this._busy
            ? `<i data-icon="loader-2" class="w-4 h-4 animate-spin"></i> `
            : ""}${escapeHtml(label)}
        </button>`;
    }

    /**
     * List-only repaint, per .claude/rules/overlays.md §6 — the panel keeps
     * its scroll position so a tick near the bottom doesn't jump the list out
     * from under the thumb.
     */
    _repaintList() {
      const root = this._sheet.el;
      if (!root) return;
      const list = root.querySelector(`#${LIST_ID}`);
      if (!list) return;
      const top = list.scrollTop;
      list.innerHTML = this._renderList();
      list.scrollTop = top;
      window.BgbIcons.render(/** @type {HTMLElement} */ (list));
      // Focus lands on the first row once there is one — the sheet opened with
      // the panel holding it, and leaving it there means Tab starts outside
      // the choices the dialog exists to offer.
      const first = /** @type {any} */ (list.querySelector("[data-export-pick]"));
      if (first && root.contains(document.activeElement)
          && document.activeElement === root.querySelector(".bgb-sheet__panel")) {
        first.focus();
      }
    }

    /** The confirm button only — its count must not repaint the list. */
    _repaintFoot() {
      const root = this._sheet.el;
      if (!root) return;
      const foot = root.querySelector(`#${FOOT_ID}`);
      if (!foot) return;
      foot.innerHTML = this._renderFoot();
      window.BgbIcons.render(/** @type {HTMLElement} */ (foot));
    }

    // ── Interaction ─────────────────────────────────────────────────────────

    _onClick(e) {
      if (this._busy) return;
      const action = e.target.closest("[data-export-action]");
      if (action) {
        const kind = action.getAttribute("data-export-action");
        if (kind === "go") this._export();
        if (kind === "retry") { this._loading = true; this._repaintList(); this._load(); }
        return;
      }
      const row = e.target.closest("[data-export-pick]");
      if (!row) return;
      const id = row.getAttribute("data-export-pick");
      if (this._picked.has(id)) this._picked.delete(id);
      else this._picked.add(id);
      // The row and the count, not the list: patching in place keeps focus on
      // the row that was just ticked, which a full list repaint would drop.
      row.setAttribute("aria-checked", this._picked.has(id) ? "true" : "false");
      this._repaintFoot();
    }

    /**
     * Build the archive and hand it over.
     *
     * Closing the sheet mid-build does NOT cancel it: the request is already
     * with the server and the archive is the thing the user asked for, so a
     * mistimed backdrop tap costs them the sheet, not the export. What the
     * sequence check below stops is the other half of that — a build from a
     * previous open painting into, or dismissing, a sheet the user has since
     * reopened and re-ticked.
     */
    async _export() {
      if (this._busy || !this._picked.size) return;
      const seq = this._seq;
      this._busy = true;
      this._repaintFoot();
      this._setRowsDisabled(true);
      try {
        const { blob, filename } = await window.api.download(
          "/export",
          { dataset: Array.from(this._picked) },
          { fallbackName: "boardgamebuddy-export.zip" },
        );
        const saved = await deliver(blob, filename);
        if (seq !== this._seq) return;
        this._busy = false;
        if (!saved) {
          // The share sheet was dismissed. Nothing failed and nothing landed,
          // so the sheet stays exactly where it was rather than claiming
          // either outcome.
          this._repaintFoot();
          this._setRowsDisabled(false);
          return;
        }
        this.dismiss();
        if (typeof showToast === "function") showToast("Export ready", "success");
      } catch (e) {
        if (seq !== this._seq) return;
        this._busy = false;
        this._repaintFoot();
        this._setRowsDisabled(false);
        if (typeof showToast === "function") {
          showToast(
            e && e.offline
              ? "You're offline — the export is built on the server."
              : (e && e.message) || "Couldn't build your export.",
            "error",
          );
        }
      }
    }

    /** Ticking during a build would export a set the request no longer has. */
    _setRowsDisabled(disabled) {
      const root = this._sheet.el;
      if (!root) return;
      root.querySelectorAll("[data-export-pick]").forEach((el) => {
        /** @type {any} */ (el).disabled = disabled;
      });
    }
  }

  /**
   * Put the archive in the user's hands. Resolves false when they backed out
   * of the share sheet, true once it has actually been handed over.
   *
   * Two paths, and the split is not cosmetic. An `<a download>` is the right
   * answer in a browser tab, but inside an installed PWA on iOS there is no
   * download UI for it to reach — the tap does nothing, silently, which is the
   * worst possible outcome for a button labelled "Export". Where the page is
   * running standalone and the platform can share files, the share sheet is
   * what offers "Save to Files", so that is the path taken there.
   *
   * @param {Blob} blob
   * @param {string} filename
   * @returns {Promise<boolean>}
   */
  async function deliver(blob, filename) {
    const standalone = !!(
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || /** @type {any} */ (window.navigator).standalone
    );
    if (standalone && typeof File === "function" && navigator.share && navigator.canShare) {
      const file = new File([blob], filename, { type: "application/zip" });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          return true;
        } catch (e) {
          // A dismissed share sheet rejects with AbortError. Anything else
          // (an unsupported target, a platform refusal) still deserves the
          // anchor rather than a dead end.
          if (e && e.name === "AbortError") return false;
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next turn, not synchronously: Safari has to have read the
    // object URL before it goes away, and it does that after the click event
    // finishes unwinding.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  window.ExportDataSheet = new ExportDataSheet();
})();
