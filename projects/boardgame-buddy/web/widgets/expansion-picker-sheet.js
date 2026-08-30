// @ts-check
// widgets/expansion-picker-sheet.js — "which expansion?" for one base game,
// as a bottom sheet. Opened from the Add expansion row in the Collection
// spoke's Expansions tree.
//
// Lists what BgB's catalog already has for a base game (GET
// /games/{id}/expansions) minus the ones you already own, so picking one is a
// single tap. The catalog is routinely missing expansions BGG knows about, so
// a footer action always hands off to widgets/import-expansions-modal.js —
// that popup is the only path by which an expansion enters the catalog, and on
// a base game with nothing imported it is the only useful thing here.
//
// Import stays catalog-only, as it is everywhere else in the app: importing
// does not add anything to your collection. The sheet reopens with the fresh
// list afterwards so the new expansion is one more tap away, no more.
//
// The sheet does NOT own the write. It calls back with the chosen expansion
// and views/collection-view.js does the optimistic add, because the tree it
// paints into is what has to roll back on failure.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; rows reuse .game-picker__row. Only .exp-picker__* is
// ours (mirroring widgets/game-picker-sheet.js).

(function () {
  /**
   * @typedef {Object} ExpansionPickerOpts
   * @property {string} baseGameId          Base game UUID.
   * @property {string} baseGameName        Used for the title and name trimming.
   * @property {string[]} [ownedIds]        Expansion game UUIDs already owned.
   * @property {(exp: any) => void} onPick  Called with the chosen ExpansionListItem.
   * @property {Element|null} [returnFocus]
   */

  class ExpansionPickerSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-expansion-picker-sheet",
        className: "exp-picker",
        label: "Add an expansion",
      });
      this._reset();
    }

    _reset() {
      this._opts = null;
      this._rows = null;
      this._error = null;
      this._loading = false;
      this._seq = 0;
    }

    /** @param {ExpansionPickerOpts} opts */
    open(opts) {
      if (!opts || !opts.baseGameId) return;
      this._reset();
      this._opts = opts;
      this._loading = true;
      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: opts.returnFocus || document.activeElement,
        label: `Add an expansion to ${opts.baseGameName || "this game"}`,
        onClick: (e) => this._onClick(e),
      });
      this._load();
    }

    dismiss() {
      this._sheet.close();
    }

    async _load() {
      const seq = ++this._seq;
      const { baseGameId } = this._opts || {};
      try {
        const list = await window.api.get(`/games/${baseGameId}/expansions`);
        if (seq !== this._seq) return; // a later open superseded this one
        this._rows = Array.isArray(list) ? list : [];
        this._error = null;
      } catch (e) {
        if (seq !== this._seq) return;
        this._rows = [];
        this._error = (e && e.message) || "Couldn't load expansions.";
      }
      this._loading = false;
      this._repaint();
    }

    /** Catalog expansions minus the ones already on the caller's shelf. */
    _available() {
      const owned = new Set((this._opts && this._opts.ownedIds) || []);
      return (this._rows || []).filter((r) => !owned.has(r.expansion_game_id));
    }

    _row(exp) {
      const label = stripBaseGameName(exp.name, (this._opts || {}).baseGameName || "");
      const art = gameArtImg(exp, "chip");
      const dot = exp.color
        ? `<span class="exp-picker__dot" style="background:${escapeAttr(exp.color)}"></span>`
        : "";
      return `
        <button class="game-picker__row" type="button" role="option" aria-selected="false"
                data-exp-pick="${escapeAttr(exp.expansion_game_id)}">
          <span class="game-picker__art${art ? "" : " game-picker__art--empty"}">${art
            || `<i data-icon="dice-6" class="w-5 h-5"></i>`}</span>
          <span class="game-picker__body">
            <span class="game-picker__name">${escapeHtml(label || exp.name || "")}</span>
          </span>
          ${dot}
          <span class="game-picker__check"><i data-icon="plus" class="w-4 h-4"></i></span>
        </button>`;
    }

    _renderBody() {
      if (this._loading) {
        return `<p class="bgb-sheet__empty">Loading expansions…</p>`;
      }
      if (this._error) {
        return `<p class="bgb-sheet__empty exp-picker__error">${escapeHtml(this._error)}</p>`;
      }
      const rows = this._available();
      if (!rows.length) {
        // Two different nothings, and the difference matters: one is "you have
        // them all", the other is "BgB doesn't know about any yet" — and only
        // the second makes the import action the primary thing to do.
        const name = (this._opts || {}).baseGameName || "this game";
        const msg = (this._rows || []).length
          ? `You already own every expansion BoardgameBuddy has for ${name}.`
          : `BoardgameBuddy doesn't have any expansions for ${name} yet.`;
        return `<p class="bgb-sheet__empty">${escapeHtml(msg)}</p>`;
      }
      return rows.map((r) => this._row(r)).join("");
    }

    _renderPanel() {
      const name = (this._opts || {}).baseGameName || "this game";
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Add an expansion</h3>
          <p class="bgb-sheet__sub">${escapeHtml(name)}</p>
          <div class="bgb-sheet__list" role="listbox" aria-label="Expansions to add"
               data-exp-picker-list>${this._renderBody()}</div>
          <button class="exp-picker__import" type="button" data-exp-picker-action="import">
            <i data-icon="download-simple" class="w-4 h-4"></i>
            <span>Import from BoardGameGeek</span>
          </button>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>`;
    }

    /** List-only repaint — the panel chrome and the sheet's scroll stay put. */
    _repaint() {
      const root = this._sheet.el;
      if (!root) return;
      const list = root.querySelector("[data-exp-picker-list]");
      if (!list) return;
      list.innerHTML = this._renderBody();
      window.BgbIcons.render(/** @type {HTMLElement} */ (list));
    }

    _onClick(e) {
      const importBtn = e.target.closest("[data-exp-picker-action='import']");
      if (importBtn) {
        this._openImport();
        return;
      }
      const row = e.target.closest("[data-exp-pick]");
      if (!row) return;
      const id = row.getAttribute("data-exp-pick");
      const exp = (this._rows || []).find((r) => r.expansion_game_id === id);
      if (!exp) return;
      const { onPick } = this._opts || {};
      this.dismiss();
      if (onPick) onPick(exp);
    }

    /**
     * Hand off to the BGG import popup, then come back. Reopening rather than
     * staying behind it keeps one modal on screen at a time, and the reopened
     * sheet picks up whatever just landed in the catalog.
     */
    _openImport() {
      const opts = this._opts;
      if (!opts) return;
      this.dismiss();
      window.ImportExpansionsModal.open({
        gameId: opts.baseGameId,
        gameName: opts.baseGameName,
        onImported: () => { this._pendingReopen = true; },
      });
      // The import popup has no "closed" callback, so watch for its removal.
      const backdrop = document.getElementById("bgb-import-expansions-modal");
      if (!backdrop) return;
      const obs = new MutationObserver(() => {
        if (document.getElementById("bgb-import-expansions-modal")) return;
        obs.disconnect();
        if (!this._pendingReopen) return;
        this._pendingReopen = false;
        this.open(opts);
      });
      obs.observe(document.body, { childList: true });
    }
  }

  window.ExpansionPickerSheet = new ExpansionPickerSheet();
})();
