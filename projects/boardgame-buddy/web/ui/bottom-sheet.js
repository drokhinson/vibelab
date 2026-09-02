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
// Used by: ui/status-tag.js, widgets/game-picker-sheet.js,
// widgets/player-picker-sheet.js, widgets/game-search-sheet.js,
// widgets/country-picker-sheet.js.
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
        const handler = this._opts && this._opts.onEscape;
        if (handler && handler()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
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
        if (t === root) { this.close(); return; }                       // backdrop
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

      if (opts.onOpen) opts.onOpen(root);
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
