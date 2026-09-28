// @ts-check
// ui/sort-dial.js — a button that unfolds into its own choices.
//
// Tapping the anchor greys the screen and lays a column of round choices over
// it, the first sitting exactly where the anchor was and the rest unfolding
// below, each with its name sliding out to its left. Picking one folds the
// column back into the anchor.
//
// Lifecycle only, as ui/bottom-sheet.js is for sheets: the caller hands in
// each choice's label and icon markup and gets the picked id back. The four
// exits (.claude/rules/overlays.md §8) are one close: a tap outside the
// choices, Escape, the back gesture, and a pick.

(function () {
  // Must match the .sort-dial closing transition in styles.css.
  const CLOSE_MS = 180;

  /**
   * @typedef {Object} DialOption
   * @property {string} id
   * @property {string} label
   * @property {string} iconHtml  Markup for the round button's face.
   */

  class SortDial {
    constructor() {
      /** @type {HTMLElement|null} */
      this._el = null;
      /** @type {HTMLElement|null} */
      this._anchor = null;
      this._back = 0;
      this._prevOverflow = "";
      this._closeTimer = /** @type {any} */ (null);
      /** @type {((id: string) => void)|null} */
      this._onPick = null;

      this._onKeyDown = (/** @type {KeyboardEvent} */ e) => {
        if (!this._el) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.close();
          return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = /** @type {HTMLElement[]} */ ([...this._el.querySelectorAll(".sort-dial__fab")]);
        const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        const step = e.key === "ArrowDown" ? 1 : items.length - 1;
        const next = items[(Math.max(i, 0) + step) % items.length];
        if (next) next.focus();
      };
      this._onViewportChange = () => this.close();
    }

    get isOpen() {
      return !!this._el;
    }

    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.anchor      The button the column grows out of.
     * @param {DialOption[]} opts.options
     * @param {string} opts.selected
     * @param {string} [opts.label]          The menu's aria-label.
     * @param {(id: string) => void} opts.onPick
     */
    open({ anchor, options, selected, label, onPick }) {
      if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
      this._teardown();
      if (!anchor) return;
      this._anchor = anchor;
      this._onPick = onPick || null;

      const rect = anchor.getBoundingClientRect();
      const root = document.createElement("div");
      root.className = "sort-dial";
      root.innerHTML = `
        <div class="sort-dial__scrim" aria-hidden="true"></div>
        <div class="sort-dial__col" role="menu" aria-label="${escapeAttr(label || "Order")}"
             style="top:${Math.round(rect.top)}px;right:${Math.round(window.innerWidth - rect.right)}px;--fab:${Math.round(rect.height)}px">
          ${options.map((o, i) => `
            <div class="sort-dial__opt" style="--i:${i}">
              <span class="sort-dial__label" aria-hidden="true">${escapeHtml(o.label)}</span>
              <button type="button" class="sort-dial__fab${o.id === selected ? " is-on" : ""}"
                      role="menuitemradio" aria-checked="${o.id === selected ? "true" : "false"}"
                      aria-label="${escapeAttr(o.label)}" data-sort="${escapeAttr(o.id)}">${o.iconHtml}</button>
            </div>`).join("")}
        </div>`;

      root.addEventListener("click", (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        const fab = t.closest("[data-sort]");
        if (fab) { this._pick(fab.getAttribute("data-sort") || ""); return; }
        // Outside the choices is outside, labels and gaps included.
        this.close();
      });

      document.body.appendChild(root);
      if (window.BgbIcons) window.BgbIcons.render(root);
      this._el = root;
      anchor.classList.add("is-dial-open");
      anchor.setAttribute("aria-expanded", "true");

      this._prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._onKeyDown, true);
      // The column is pinned to where the anchor was measured; a resize or
      // rotation would leave it floating over the wrong control.
      window.addEventListener("resize", this._onViewportChange);
      this._back = window.BgbBackGuard
        ? window.BgbBackGuard.arm({ root, close: () => this.close() })
        : 0;

      // Committed before the open class, so the unfold transitions from the
      // folded state rather than appearing already open.
      void root.offsetWidth;
      root.classList.add("is-open");
      const on = /** @type {HTMLElement|null} */ (root.querySelector(".sort-dial__fab.is-on"))
        || /** @type {HTMLElement|null} */ (root.querySelector(".sort-dial__fab"));
      if (on) on.focus({ preventScroll: true });
    }

    /** @param {string} id */
    _pick(id) {
      // The pick repaints first so the list has re-ordered by the time the
      // column folds away, and close() finds the repainted anchor to focus.
      const pick = this._onPick;
      if (pick && id) pick(id);
      this.close();
    }

    close() {
      const root = this._el;
      if (!root) return;
      this._el = null;
      this._onPick = null;

      document.removeEventListener("keydown", this._onKeyDown, true);
      window.removeEventListener("resize", this._onViewportChange);
      document.body.style.overflow = this._prevOverflow;
      if (window.BgbBackGuard) window.BgbBackGuard.release(this._back);
      this._back = 0;

      const anchor = this._anchor;
      this._anchor = null;
      if (anchor) {
        anchor.classList.remove("is-dial-open");
        anchor.setAttribute("aria-expanded", "false");
      }
      // A pick usually repaints the screen and replaces the anchor, so focus
      // goes back to whatever now carries its id — and only if it was still in
      // the dial, so a user who has moved on is left where they are.
      if (root.contains(document.activeElement)) {
        const back = anchor && anchor.isConnected ? anchor
          : (anchor && anchor.id ? document.getElementById(anchor.id) : null);
        if (back) back.focus({ preventScroll: true });
        else /** @type {HTMLElement} */ (document.activeElement).blur();
      }

      root.classList.remove("is-open");
      root.classList.add("is-closing");
      root.style.pointerEvents = "none";
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        root.remove();
      }, CLOSE_MS);
    }

    _teardown() {
      document.querySelectorAll(".sort-dial").forEach((n) => n.remove());
    }
  }

  window.BgbSortDial = new SortDial();
})();
