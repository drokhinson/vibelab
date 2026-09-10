// @ts-check
// ui/bottom-sheet.js — the shell every bottom sheet in the app shares.
//
// A sheet is a body-level element (so it survives the `container.innerHTML =`
// swap any view does) riding the project's polaroid modal chrome: it takes
// `.polaroid-popup__backdrop` for the dim + blur AND for the visual-viewport
// sizing that keeps it clear of the iOS keyboard and home indicator (see
// ui/viewport-lock.js), then re-anchors itself to the bottom of the screen.
//
// This class owns the lifecycle only — create, scroll lock, delegated clicks,
// Escape, the device back gesture (ui/back-guard.js), focus return, the close
// animation. Each sheet still writes its own panel markup and its own CSS
// family; nothing about how a sheet LOOKS lives here.
// Extracted when the status sheet stopped being the only one
// (.claude/rules/ui-object-design.md §4: fix the root cause rather than ship a
// second copy).
//
// Grep `BgbBottomSheet` for the consumers — a list here drifted twice.
//
// A new sheet also needs its class added by name to the theme re-point list in
// styles.css — a body-level sheet lands outside the screen that opened it and
// would otherwise keep the root paper aliases. See .claude/rules/theming.md §8.

(function () {
  // Must match the .is-closing animation duration in styles.css.
  const CLOSE_MS = 200;

  /**
   * @typedef {Object} BottomSheetConfig
   * @property {string} id         DOM id for the backdrop — unique per sheet.
   * @property {string} className  The sheet's own class, e.g. "status-sheet".
   *   The root also gets `bgb-sheet`, which carries the shared panel chrome.
   *   Any BACKDROP rule this class adds must select
   *   `.polaroid-popup__backdrop.<className>`, not the bare class: the base
   *   backdrop rule is LATER in styles.css and sets align-items:center, so a
   *   single-class selector loses the tie and the sheet renders centred.
   * @property {string} [label]    Default aria-label for the dialog.
   */

  /**
   * @typedef {Object} BottomSheetOpenOpts
   * @property {string} html                     The panel markup.
   * @property {Element|null} [returnFocus]      Focus goes back here on close.
   * @property {string} [label]                  Overrides the config label.
   * @property {(e: any) => void} [onClick]      Delegated click, called for
   *   anything the shell didn't already handle (backdrop, [data-action=close]).
   * @property {() => boolean} [onEscape]        Return true to swallow this
   *   Escape (e.g. "clear the query first"); false/absent closes the sheet.
   * @property {(root: HTMLElement) => void} [onOpen]  Runs after the sheet is
   *   in the DOM and its icons are hydrated — focus a control here.
   * @property {() => void} [onClose]
   * @property {SheetSearch} [search]  A search field that narrows the list.
   */

  /**
   * The lifecycle every searchable sheet had grown its own copy of: bind the
   * field, pin the list at its opening height, and give Escape first refusal
   * to clearing the query. The list patch itself stays with the sheet —
   * what a keystroke repaints (rows, tabs, a footer count) is the sheet's.
   * @typedef {Object} SheetSearch
   * @property {string} listSel                 The list host to pin.
   * @property {(value: string) => void} onQuery  Every keystroke, and the ×.
   * @property {string} [inputSel]              Default ".game-finder__input".
   */

  class BottomSheet {
    /** @param {BottomSheetConfig} config */
    constructor(config) {
      this._id = config.id;
      this._className = config.className;
      this._label = config.label || "";

      /** @type {HTMLElement|null} */
      this._el = null;
      this._opts = /** @type {BottomSheetOpenOpts|null} */ (null);
      // Token for the device-back guard, so the phone's back gesture closes
      // this sheet instead of the screen behind it (ui/back-guard.js).
      this._back = 0;
      this._returnFocus = /** @type {any} */ (null);
      this._closeTimer = /** @type {any} */ (null);
      this._prevOverflow = "";

      this._onKeyDown = (/** @type {KeyboardEvent} */ e) => {
        if (e.key !== "Escape" || !this._el) return;
        // The sheet gets first refusal: a sheet with a search field wants the
        // first Escape to clear the query and only the second to close.
        e.preventDefault();
        e.stopPropagation();
        const handler = this._opts && this._opts.onEscape;
        if (handler && handler()) return;
        // Layered: with a query up, Escape backs out of the search and only
        // the next press closes. The × takes the same path — BgbSearchField
        // empties the box and dispatches the `input` event onQuery listens
        // for, so "clear and repaint" is written once. Ticks are never
        // unwound by Escape; that is what Cancel is for.
        const search = this._opts && this._opts.search;
        const input = search && this._el.querySelector(search.inputSel || ".game-finder__input");
        if (input && /** @type {HTMLInputElement} */ (input).value) {
          window.BgbSearchField.clear(this._el);
          return;
        }
        this.close();
      };
    }

    /** The live backdrop element, or null when closed. */
    get el() {
      return this._el;
    }

    get isOpen() {
      return !!this._el;
    }

    /** @param {BottomSheetOpenOpts} opts */
    open(opts) {
      // A second open while one is closing would otherwise let the pending
      // teardown remove the new sheet.
      if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
      this._teardown();

      this._opts = opts;
      this._returnFocus = opts.returnFocus || null;

      const root = document.createElement("div");
      root.id = this._id;
      // bgb-sheet carries the shared panel chrome (see styles.css); the
      // per-sheet class carries only that sheet's own rules.
      root.className = `polaroid-popup__backdrop bgb-sheet ${this._className}`;
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", opts.label || this._label);
      root.innerHTML = opts.html;

      root.addEventListener("click", (e) => {
        const t = /** @type {any} */ (e.target);
        // Outside the panel, not merely "on the backdrop element": a sheet's
        // markup is one panel, so today the two tests agree — but chrome parked
        // BESIDE the panel would be a sibling of it, and an `=== root` test
        // leaves any such strip of apparent background inert
        // (.claude/rules/overlays.md §8a, where exactly that shipped).
        const panel = root.firstElementChild;
        if (t === root || (panel && !panel.contains(t))) { this.close(); return; }
        if (t.closest('[data-action="close"]')) { this.close(); return; }
        if (opts.onClick) opts.onClick(e);
      });

      document.body.appendChild(root);
      window.BgbIcons.render(root);
      this._el = root;

      this._prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._onKeyDown, true);
      this._back = window.BgbBackGuard
        ? window.BgbBackGuard.arm({ root: root, close: () => this.close() })
        : 0;

      if (opts.search) this._bindSearch(root, opts.search);
      if (opts.onOpen) opts.onOpen(root);
    }

    /** @param {HTMLElement} root @param {SheetSearch} search */
    _bindSearch(root, search) {
      const input = root.querySelector(search.inputSel || ".game-finder__input");
      if (input) input.addEventListener("input", () => search.onQuery(/** @type {HTMLInputElement} */ (input).value));
      // Pin the list at the height it opened with, so the panel doesn't walk
      // up and down the screen on every keystroke that narrows the results.
      // A custom property, not min-height: the stylesheet drops the pin when
      // the keyboard shrinks the sheet, and an inline min-height would
      // out-specify it (.claude/rules/overlays.md §4).
      const list = /** @type {HTMLElement|null} */ (root.querySelector(search.listSel));
      if (list) list.style.setProperty("--bgb-sheet-list-min", list.clientHeight + "px");
    }

    close() {
      const root = this._el;
      if (!root) return;
      this._el = null;
      const opts = this._opts;
      this._opts = null;

      document.removeEventListener("keydown", this._onKeyDown, true);
      document.body.style.overflow = this._prevOverflow;
      if (window.BgbBackGuard) window.BgbBackGuard.release(this._back);
      this._back = 0;

      const back = this._returnFocus;
      this._returnFocus = null;
      // Only pull focus back if it's still inside the sheet — a pick that
      // re-rendered the originating control leaves a detached node behind.
      if (back && back.isConnected && root.contains(document.activeElement)) {
        try { back.focus(); } catch (_) {}
      }

      root.classList.add("is-closing");
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        if (root.parentNode) root.parentNode.removeChild(root);
      }, CLOSE_MS);

      if (opts && opts.onClose) opts.onClose();
    }

    /** Remove any live or orphaned instance of this sheet immediately. */
    _teardown() {
      if (window.BgbBackGuard) window.BgbBackGuard.release(this._back);
      this._back = 0;
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      const stale = document.getElementById(this._id);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      this._el = null;
      this._opts = null;
      document.removeEventListener("keydown", this._onKeyDown, true);
    }
  }

  window.BgbBottomSheet = BottomSheet;
})();
