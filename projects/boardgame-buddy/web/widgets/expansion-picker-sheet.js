// @ts-check
// widgets/expansion-picker-sheet.js — "which expansions?" for one base game,
// as a MULTI-SELECT bottom sheet. Opened from the Add expansion row in the
// Collection spoke's Expansions tree, and from the Expansions card in the
// play-detail popup's edit form.
//
// Lists what BgB's catalog already has for a base game (GET
// /games/{id}/expansions) minus the ones the caller already has. The catalog
// is routinely missing expansions BGG knows about, so a footer action always
// hands off to widgets/import-expansions-modal.js — that popup is the only path
// by which an expansion enters the catalog, and on a base game with nothing
// imported it is the only useful thing here.
//
// Import stays catalog-only, as it is everywhere else in the app: importing
// does not add anything to your collection. The sheet reopens with the fresh
// list afterwards so the new expansion is one more tap away, no more — and it
// reopens with your ticks intact, because a round trip to BGG is not a decision
// to start the selection over.
//
// It is MULTI-SELECT, and was not: every pick used to close the sheet, so a
// play with three expansions cost three opens, three reads of the same list and
// three taps on "Add an expansion". Which expansions were on the table is a
// SET — a play carries expansion_ids, a shelf carries a group of them — and
// ".claude/rules/overlays.md" names the old shape under its anti-patterns: "a
// single-select combo used to pick N things one at a time. If the underlying
// model is a set, the sheet is multi-select with one confirm."
//
// It is deliberately the same sheet as widgets/player-picker-sheet.js, down to
// the method names: ticked rows ride at the top under "Selected" in tick order
// and leave the body list, a query filters that section by the same predicate
// as every other row, and one footer button commits the lot. The two put the
// same kind of question to the user — which of these were in this play? — so
// they answer it the same way.
//
// The sheet does NOT own the write. It calls back with the chosen expansions
// and the caller does the optimistic add, because the surface it paints into is
// what has to roll back on failure.
//
// The shell is ui/bottom-sheet.js and the panel chrome is the shared
// .bgb-sheet__* family; rows reuse .game-picker__row. Only .exp-picker__* is
// ours (mirroring widgets/game-picker-sheet.js).

(function () {
  /**
   * @typedef {Object} ExpansionPickerOpts
   * @property {string} baseGameId          Base game UUID.
   * @property {string} baseGameName        Used for the title and name trimming.
   * @property {string[]} [ownedIds]        Expansion game UUIDs already held —
   *   already on the shelf, or already on the play being edited.
   * @property {(exps: any[]) => void} onConfirm  Called with the chosen
   *   ExpansionListItems, in tick order.
   * @property {Element|null} [returnFocus]
   */

  const LIST_SEL = "[data-exp-picker-list]";
  const INPUT_ID = "exp-picker-search";

  class ExpansionPickerSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-expansion-picker-sheet",
        className: "exp-picker",
        label: "Add expansions",
      });
      this._reset();
    }

    _reset() {
      this._opts = null;
      this._rows = null;
      this._error = null;
      this._loading = false;
      this._seq = 0;
      /** Tick order — the order the caller will add them in. @type {any[]} */
      this._picked = [];
      this._query = "";
    }

    /** @param {ExpansionPickerOpts} opts */
    open(opts) {
      if (!opts || !opts.baseGameId) return;
      // Ticks made before an Import round trip, carried across the reopen.
      const carry = this._pendingPicked || null;
      this._pendingPicked = null;
      this._reset();
      this._opts = opts;
      this._loading = true;
      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: opts.returnFocus || document.activeElement,
        label: `Add expansions to ${opts.baseGameName || "this game"}`,
        onClick: (e) => this._onClick(e),
        search: { listSel: LIST_SEL, inputSel: `#${INPUT_ID}`, onQuery: (v) => this._setQuery(v) },
        onOpen: (root) => this._onOpen(root),
        onClose: () => this._reset(),
      });
      this._load(carry);
    }

    dismiss() {
      this._sheet.close();
    }

    /**
     * Focus the first row, not the search box: opening the sheet must not raise
     * a software keyboard over the very list it is offering
     * (.claude/rules/overlays.md §5). There is rarely a row to land on at this
     * point — the list is still loading — so in practice the panel takes it,
     * which is what makes a screen reader read the sheet's label.
     * @param {HTMLElement} root
     */
    _onOpen(root) {
      const firstRow = /** @type {HTMLElement|null} */ (root.querySelector(".game-picker__row"));
      const panel = /** @type {HTMLElement|null} */ (root.querySelector(".bgb-sheet__panel"));
      const landing = firstRow || panel;
      if (landing) landing.focus({ preventScroll: true });
    }

    /** @param {any[]|null} [carry] ticks to restore after an Import reopen. */
    async _load(carry) {
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
      // Re-resolve carried ticks against the rows that just landed rather than
      // trusting the old objects: an import can have changed what the catalog
      // says about one of them, and the row the list is painted from should be
      // the row the caller is handed.
      if (carry && carry.length) {
        const byId = new Map((this._rows || []).map((r) => [r.expansion_game_id, r]));
        this._picked = carry
          .map((p) => byId.get(p.expansion_game_id) || p)
          .filter((p) => !this._isOwned(p.expansion_game_id));
      }
      this._repaint();
    }

    /** @param {string} id */
    _isOwned(id) {
      return ((this._opts && this._opts.ownedIds) || []).indexOf(id) >= 0;
    }

    /** Catalog expansions minus the ones the caller already has. */
    _available() {
      const owned = new Set((this._opts && this._opts.ownedIds) || []);
      return (this._rows || []).filter((r) => !owned.has(r.expansion_game_id));
    }

    /** The label a row is painted with — the full name minus the base game's. */
    _label(exp) {
      return stripBaseGameName(exp.name, (this._opts || {}).baseGameName || "")
        || exp.name || "";
    }

    /**
     * One row against one query. BOTH the trimmed label and the full name
     * match, the same predicate the Gather card's own expansion filter uses
     * (views/play-flow-view.js#_expansionMatches): the list is painted with
     * "Cities & Knights" but somebody who types "Catan" is looking for exactly
     * these rows, and a filter that hid them would be answering a different
     * question from the one they asked.
     * @param {any} exp
     * @param {string} q Already trimmed and lowercased.
     */
    _hits(exp, q) {
      if (!q) return true;
      return this._label(exp).toLowerCase().includes(q)
        || String(exp.name || "").toLowerCase().includes(q);
    }

    /** @param {string} id */
    _isPicked(id) {
      return this._picked.some((p) => p.expansion_game_id === id);
    }

    /** @param {any} exp */
    _row(exp) {
      const on = this._isPicked(exp.expansion_game_id);
      const art = gameArtImg(exp, "chip");
      const dot = exp.color
        ? `<span class="exp-picker__dot" style="background:${escapeAttr(exp.color)}"></span>`
        : "";
      // role=checkbox + aria-checked, not the role=option with a hard-coded
      // aria-selected="false" this row carried while it was single-select — a
      // listbox option that is never selected describes a control that cannot
      // be ticked, which is what this one used to be.
      return `
        <button class="game-picker__row" type="button" role="checkbox"
                aria-checked="${on ? "true" : "false"}"
                data-exp-pick="${escapeAttr(exp.expansion_game_id)}">
          <span class="game-picker__art${art ? "" : " game-picker__art--empty"}">${art
            || `<i data-icon="dice-6" class="w-5 h-5"></i>`}</span>
          <span class="game-picker__body">
            <span class="game-picker__name">${escapeHtml(this._label(exp))}</span>
          </span>
          ${dot}
          <span class="game-picker__check${on ? "" : " game-picker__check--off"}">
            <i data-icon="${on ? "check" : "plus"}" class="w-4 h-4"></i>
          </span>
        </button>`;
    }

    /** A section heading. @param {string} text */
    _sec(text) {
      return `<div class="bgb-sheet__sec">${escapeHtml(text)}</div>`;
    }

    /**
     * WHAT THE SHEET IS ABOUT TO DO, at the top, always. Ticked rows render
     * here and nowhere else — _renderList() takes them out of the body — so
     * clearing the search box cannot scatter the four you just ticked back
     * through a list of forty.
     *
     * A query filters this section by the same predicate as everything else: a
     * pick that doesn't answer what you typed is not an answer to it. It comes
     * straight back when the box empties, because `_picked` is the state and
     * this is only where it is painted.
     */
    _pickedSection() {
      if (!this._picked.length) return "";
      const q = this._query.trim().toLowerCase();
      const rows = this._picked.filter((e) => this._hits(e, q));
      if (!rows.length) return "";
      return this._sec("Selected") + rows.map((e) => this._row(e)).join("");
    }

    _renderList() {
      if (this._loading) {
        return `<p class="bgb-sheet__empty">Loading expansions…</p>`;
      }
      if (this._error) {
        return `<p class="bgb-sheet__empty exp-picker__error">${escapeHtml(this._error)}</p>`;
      }
      const q = this._query.trim().toLowerCase();
      const picked = this._pickedSection();
      const rest = this._available()
        .filter((e) => !this._isPicked(e.expansion_game_id))
        .filter((e) => this._hits(e, q));
      if (!picked && !rest.length) {
        // Three different nothings now, and the differences matter: one is
        // "your search matched none of them", one is "you have them all", and
        // one is "BgB doesn't know about any yet" — only the last makes the
        // import action the primary thing to do.
        const name = (this._opts || {}).baseGameName || "this game";
        const msg = q
          ? `No expansion matches “${this._query.trim()}”.`
          : ((this._rows || []).length
              ? `You already have every expansion BoardgameBuddy has for ${name}.`
              : `BoardgameBuddy doesn't have any expansions for ${name} yet.`);
        return `<p class="bgb-sheet__empty">${escapeHtml(msg)}</p>`;
      }
      return picked + rest.map((e) => this._row(e)).join("");
    }

    /** The confirm button's label and disabled state both track the tick count. */
    _renderConfirm() {
      const n = this._picked.length;
      return `
        <button class="bgb-sheet__confirm" type="button" data-exp-picker-action="confirm"
                ${n ? "" : "disabled"}>
          ${n ? `Add ${n} expansion${n === 1 ? "" : "s"}` : "Select expansions to add"}
        </button>`;
    }

    _renderPanel() {
      const name = (this._opts || {}).baseGameName || "this game";
      return `
        <div class="bgb-sheet__panel" tabindex="-1">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Add expansions</h3>
          <p class="bgb-sheet__sub">${escapeHtml(name)}</p>
          <div class="game-finder bgb-sheet__search" data-search-host>
            <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
            <input type="text" id="${INPUT_ID}"
                   class="input input-bordered game-finder__input"
                   placeholder="Search expansions…"
                   aria-label="Search expansions"
                   autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" />
            ${window.BgbSearchField.clearButton()}
          </div>
          <div class="bgb-sheet__list" role="group" aria-label="Expansions to add"
               data-exp-picker-list>${this._renderList()}</div>
          <div class="bgb-sheet__foot" data-exp-picker-foot>${this._renderConfirm()}</div>
          <button class="exp-picker__import" type="button" data-exp-picker-action="import">
            <i data-icon="download" class="w-4 h-4"></i>
            <span>Import from BoardGameGeek</span>
          </button>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>`;
    }

    /**
     * Patch the list and the footer only — the panel chrome, the sheet's scroll
     * and the field the user is typing into all stay put
     * (.claude/rules/overlays.md §6).
     * @param {boolean} [keepScroll]
     */
    _repaint(keepScroll) {
      const root = this._sheet.el;
      if (!root) return;
      const list = /** @type {HTMLElement|null} */ (root.querySelector(LIST_SEL));
      if (list) {
        const top = list.scrollTop;
        list.innerHTML = this._renderList();
        list.scrollTop = keepScroll ? top : 0;
        window.BgbIcons.render(list);
      }
      const foot = /** @type {HTMLElement|null} */ (root.querySelector("[data-exp-picker-foot]"));
      if (foot) foot.innerHTML = this._renderConfirm();
    }

    /** @param {string} value */
    _setQuery(value) {
      this._query = value || "";
      this._repaint();
    }

    /** @param {string} id */
    _toggle(id) {
      const i = this._picked.findIndex((p) => p.expansion_game_id === id);
      if (i >= 0) {
        this._picked.splice(i, 1);
      } else {
        const exp = (this._rows || []).find((r) => r.expansion_game_id === id);
        if (!exp) return;
        this._picked.push(exp);
      }
      // Ticking must not scroll the list out from under the thumb.
      this._repaint(true);
    }

    /**
     * Close first, then hand the picks back: the caller's own re-render then
     * lands on a screen the sheet has already let go of, rather than under it.
     */
    _confirm() {
      const picks = this._picked.slice();
      if (!picks.length) return;
      const cb = this._opts && this._opts.onConfirm;
      this.dismiss();
      if (cb) cb(picks);
    }

    _onClick(e) {
      if (e.target.closest("[data-exp-picker-action='import']")) { this._openImport(); return; }
      if (e.target.closest("[data-exp-picker-action='confirm']")) { this._confirm(); return; }
      const row = e.target.closest("[data-exp-pick]");
      if (row) this._toggle(row.getAttribute("data-exp-pick"));
    }

    /**
     * Hand off to the BGG import popup, then come back. Reopening rather than
     * staying behind it keeps one modal on screen at a time, and the reopened
     * sheet picks up whatever just landed in the catalog — with the ticks made
     * before the detour still on, since going to fetch a missing expansion is
     * not a decision to start choosing again.
     */
    _openImport() {
      const opts = this._opts;
      if (!opts) return;
      const picked = this._picked.slice();
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
        this._pendingPicked = picked;
        this.open(opts);
      });
      obs.observe(document.body, { childList: true });
    }
  }

  window.ExpansionPickerSheet = new ExpansionPickerSheet();
})();
