// @ts-check
// ui/modal-shell.js — the shell every centred modal card shares.
//
// The sibling of ui/bottom-sheet.js: a body-level `.polaroid-popup__backdrop`
// with a card in the middle instead of a panel at the bottom. Same contract —
// this class owns the lifecycle only: create, scroll lock, delegated clicks,
// the four exits (×, a tap outside the card, Escape, the device back gesture)
// wired to one close(), focus return, the close animation. Each modal still
// writes its own card markup and its own CSS family; nothing about how a
// card LOOKS lives here (.claude/rules/ui-object-design.md §4).
//
// ui/polaroid-popup.js is not a consumer: it is the wrap-up / confirm /
// avatar family with a lifecycle of its own (a singleton by design, an
// in-place update() path). Grep `BgbModal` for the consumers.

(function () {
  // Must match the .bgb-modal.is-closing animation duration in styles.css.
  const CLOSE_MS = 200;

  /**
   * @typedef {Object} ModalConfig
   * @property {string} id           DOM id for the backdrop — unique per modal.
   * @property {string} [className]  The modal's own backdrop class.
   * @property {string} [label]      Default aria-label for the dialog.
   */

  /**
   * @typedef {Object} ModalOpenOpts
   * @property {string} html                     The card markup.
   * @property {Element|null} [returnFocus]      Focus goes back here on close.
   * @property {string} [label]                  Overrides the config label.
   * @property {(e: any) => void} [onClick]      Delegated click, called for
   *   anything the shell didn't already handle (outside the card, the ×,
   *   [data-action=close]).
   * @property {() => boolean} [onEscape]        Return true to swallow this
   *   Escape (e.g. "clear the filter first"); false/absent closes the modal.
   * @property {() => boolean} [canDismiss]      Return false to refuse the
   *   outside tap, Escape and the back gesture — a card mid-save is modal.
   *   The × and close() itself are never refused.
   * @property {(root: HTMLElement) => void} [onOpen]  Runs after the card is
   *   in the DOM and its icons are hydrated — focus something here.
   * @property {() => void} [onClose]
   */

  class BgbModal {
    /** @param {ModalConfig} config */
    constructor(config) {
      this._id = config.id;
      this._className = config.className || "";
      this._label = config.label || "";

      /** @type {HTMLElement|null} */
      this._el = null;
      this._opts = /** @type {ModalOpenOpts|null} */ (null);
      this._back = 0;
      this._returnFocus = /** @type {any} */ (null);
      this._closeTimer = /** @type {any} */ (null);
      this._prevOverflow = "";

      this._onKeyDown = (/** @type {KeyboardEvent} */ e) => {
        if (e.key !== "Escape" || !this._el) return;
        e.preventDefault();
        e.stopPropagation();
        const handler = this._opts && this._opts.onEscape;
        if (handler && handler()) return;
        if (this._dismissible()) this.close();
      };
    }

    /** The live backdrop element, or null when closed. */
    get el() {
      return this._el;
    }

    get isOpen() {
      return !!(this._el && this._el.isConnected);
    }

    _dismissible() {
      const test = this._opts && this._opts.canDismiss;
      return test ? !!test() : true;
    }

    /** @param {ModalOpenOpts} opts */
    open(opts) {
      // A second open while one is closing would otherwise let the pending
      // teardown remove the new card.
      if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
      this._teardown();

      this._opts = opts;
      this._returnFocus = opts.returnFocus || null;

      const root = document.createElement("div");
      root.id = this._id;
      root.className = `polaroid-popup__backdrop bgb-modal ${this._className}`.trim();
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", opts.label || this._label);
      root.innerHTML = opts.html;

      root.addEventListener("click", (e) => {
        const t = /** @type {any} */ (e.target);
        // Outside the card is outside, whatever it landed on
        // (.claude/rules/overlays.md §8a).
        if (!t.closest(".polaroid-popup__card")) {
          if (this._dismissible()) this.close();
          return;
        }
        if (t.closest('.polaroid-popup__close, [data-action="close"]')) { this.close(); return; }
        if (opts.onClick) opts.onClick(e);
      });

      document.body.appendChild(root);
      window.BgbIcons.render(root);
      this._el = root;

      this._prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._onKeyDown, true);
      // Back takes the outside-tap exit — including its refusal, which re-arms
      // the guard rather than spending the press on the screen underneath.
      const backExit = () => {
        if (!this._dismissible()) { this._arm(root, backExit); return; }
        this.close();
      };
      this._arm(root, backExit);

      if (opts.onOpen) opts.onOpen(root);
    }

    _arm(root, exit) {
      this._back = window.BgbBackGuard
        ? window.BgbBackGuard.arm({ root: root, close: exit })
        : 0;
    }

    close() {
      const root = this._el;
      if (!root) return;
      this._el = null;
      const opts = this._opts;
      this._opts = null;

      document.removeEventListener("keydown", this._onKeyDown, true);
      // Restored now, not after the animation: the next card may open inside
      // those 200ms and must save a lock-free page, or it unlocks itself.
      document.body.style.overflow = this._prevOverflow;
      if (window.BgbBackGuard) window.BgbBackGuard.release(this._back);
      this._back = 0;

      const back = this._returnFocus;
      this._returnFocus = null;
      // Only pull focus back if it's still inside the card — a pick that
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

    /** Remove any live or orphaned instance of this modal immediately. */
    _teardown() {
      if (window.BgbBackGuard) window.BgbBackGuard.release(this._back);
      this._back = 0;
      if (this._el) document.body.style.overflow = this._prevOverflow;
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      const stale = document.getElementById(this._id);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      this._el = null;
      this._opts = null;
      document.removeEventListener("keydown", this._onKeyDown, true);
    }
  }

  window.BgbModal = BgbModal;
})();
