// @ts-check
// widgets/shelf-picker-sheet.js — "which shelf am I looking at" chooser.
//
// The Collection spoke used to carry a row of toggle pills. At three they were
// already squeezed (.spoke-toggle--3 dropped the labels to 0.72rem to fit a
// 390px screen); Wishlist made four, which does not fit at all. So the control
// became a dropdown — a trigger that states the current shelf, and this sheet
// as the list behind it.
//
// It is a sheet rather than an absolute dropdown because the trigger sits under
// a pinned sub-header on a screen with docked chrome, which is exactly the
// geometry .claude/rules/overlays.md says to stop patching: a dropdown there
// needs a fit pass, a flip and a z-index override, and the software keyboard
// does not shrink it. A sheet is fixed, sized off the visible viewport, and
// none of that can arise.
//
// Lifecycle — creation, scroll lock, Escape, focus return, close animation —
// belongs to ui/bottom-sheet.js. This file owns the panel markup and nothing
// else. The row family (.bgb-sheet__opt*) is the shared one, promoted out of
// the status sheet when this became its second user.

(function () {
  /**
   * @typedef {Object} ShelfOption
   * @property {string} id      Shelf id — what onPick hands back.
   * @property {string} label   Row text.
   * @property {string} [icon]  Vendored icon name (ui/icons.js).
   * @property {string} [noun]  Singular unit for the count line ("game").
   */

  class ShelfPickerSheet {
    constructor() {
      /** @type {ShelfOption[]} */
      this._options = [];
      this._selected = "";
      /** @type {Record<string, number>} */
      this._counts = {};
      /** @type {((id: string) => void)|null} */
      this._onPick = null;

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-shelf-picker-sheet",
        className: "shelf-picker-sheet",
        label: "Choose a shelf",
      });
    }

    _renderPanel() {
      const rows = this._options.map((o) => {
        const on = o.id === this._selected;
        const n = this._counts[o.id];
        const noun = o.noun || "game";
        // The number is the row's whole sub-line, so it needs its unit spelled
        // out for a screen reader — "42" alone says nothing about what of.
        const countLabel = typeof n === "number"
          ? `${n} ${noun}${n === 1 ? "" : "s"}`
          : "";
        return `
          <button class="bgb-sheet__opt" type="button" role="option"
                  aria-selected="${on ? "true" : "false"}" data-shelf="${escapeAttr(o.id)}">
            <i data-icon="${escapeAttr(o.icon || "list")}" class="w-5 h-5"></i>
            <span class="bgb-sheet__opt-label">${escapeHtml(o.label)}</span>
            ${countLabel
              ? `<span class="bgb-sheet__opt-count" aria-label="${escapeAttr(countLabel)}">${n}</span>`
              : ""}
            <span class="bgb-sheet__radio" aria-hidden="true"></span>
          </button>`;
      }).join("");

      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Show</h3>
          <div class="bgb-sheet__list" role="listbox" aria-label="Shelf">${rows}</div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    /**
     * @param {Object} opts
     * @param {ShelfOption[]} opts.options
     * @param {string} opts.selected
     * @param {Record<string, number>} [opts.counts]  id → row count.
     * @param {Element|null} [opts.returnFocus]
     * @param {(id: string) => void} opts.onPick
     */
    open({ options, selected, counts, returnFocus, onPick }) {
      this._options = Array.isArray(options) ? options : [];
      this._selected = selected || "";
      this._counts = counts || {};
      this._onPick = onPick || null;

      this._sheet.open({
        html: this._renderPanel(),
        returnFocus: returnFocus || null,
        onClick: (e) => {
          const row = e.target.closest("[data-shelf]");
          if (!row) return;
          const id = row.getAttribute("data-shelf");
          const pick = this._onPick;
          // Close first: the pick rebuilds the screen underneath, and the
          // shell's focus return checks that focus is still inside the sheet —
          // which it is, right now, and would not be a frame later.
          this.close();
          if (pick && id) pick(id);
        },
        // No search field here, so Escape has nothing to clear and the shell's
        // default (close) is right. Focus lands on the checked row so a
        // keyboard or screen-reader user hears the shelf they are on before the
        // alternatives — .claude/rules/overlays.md §5.
        onOpen: (root) => {
          const target = root.querySelector('[aria-selected="true"]')
            || root.querySelector(".bgb-sheet__opt");
          if (target) /** @type {HTMLElement} */ (target).focus();
        },
      });
    }

    close() {
      this._sheet.close();
    }

    get isOpen() {
      return this._sheet.isOpen;
    }
  }

  window.ShelfPickerSheet = new ShelfPickerSheet();
})();
