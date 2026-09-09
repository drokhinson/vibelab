// @ts-check
// widgets/scoring-template-sheet.js — pick which scoring grid this play uses.
//
// Only opens when the host has MORE THAN ONE scoring-grid chapter in their
// guide for this game (Everdell base vs. Everdell + Pearlbrook). With exactly
// one, play-flow-view applies it silently; with none, nothing here runs.
//
// A sheet rather than a dropdown, per .claude/rules/overlays.md §1 — and this
// one would have been a textbook case for the geometry that rule is about: the
// control lives in the scoring card's head, which on a six-player table already
// sits under a grid tall enough to have its own scrollport.
//
// NO FETCH. The rows come from the reference-guide scroll's own my-chapters
// load, handed over on the `guide-chapters-loaded` event — the same list the
// host can see behind this sheet, which is what stops the sheet and the guide
// disagreeing about what is in it.
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} TemplateChapter
   * @property {string} id
   * @property {string} title
   * @property {{rows: Array<{label: string, color: string}>}} grid
   * @property {string} [source_game_name]
   */

  const LIST_SEL = "[data-tmpl-list]";

  class ScoringTemplateSheet {
    constructor() {
      /** @type {TemplateChapter[]} */
      this._templates = [];
      /** @type {string|null} */
      this._activeId = null;
      this._onPick = /** @type {any} */ (null);

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-scoring-template-sheet",
        className: "tmpl-sheet",
        label: "Scoring template",
      });
    }

    get isOpen() { return this._sheet.isOpen; }

    /**
     * @param {{templates: TemplateChapter[], activeId?: string|null,
     *          returnFocus?: Element|null,
     *          onPick: (t: TemplateChapter|null) => void}} opts
     */
    open(opts) {
      this._templates = opts.templates || [];
      this._activeId = opts.activeId || null;
      this._onPick = opts.onPick;

      this._sheet.open({
        html: this._renderPanel(),
        label: "Scoring template",
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          const row = e.target.closest("[data-tmpl-id]");
          if (row) this._pick(row.dataset.tmplId);
        },
        onOpen: (root) => {
          // Focus the current selection, else the first row — never a text
          // input, of which this sheet has none anyway (overlays.md §5). It
          // gives a screen reader the dialog's label and puts Tab inside the
          // sheet rather than on the page behind it.
          const list = root.querySelector(LIST_SEL);
          if (!list) return;
          const current = list.querySelector('[aria-selected="true"]');
          const first = list.querySelector("[data-tmpl-id]");
          const target = /** @type {HTMLElement|null} */ (current || first);
          if (target) target.focus();
        },
      });
    }

    close() { this._sheet.close(); }

    _pick(id) {
      const picked = id === "__none__"
        ? null
        : this._templates.find((t) => t.id === id) || null;
      // Close first: the host's grid repaints behind the sheet, and applying a
      // template can change its row count, so the sheet coming down first is
      // what makes the change read as "the table I just chose".
      this._sheet.close();
      if (this._onPick) this._onPick(picked);
    }

    _renderPanel() {
      const rows = this._templates.map((t) => {
        const on = t.id === this._activeId;
        const n = ((t.grid && t.grid.rows) || []).length;
        const from = t.source_game_name
          ? ` · ${t.source_game_name}`
          : "";
        return `
          <button type="button" role="option" aria-selected="${on ? "true" : "false"}"
                  class="tmpl-sheet__row ${on ? "tmpl-sheet__row--on" : ""}"
                  data-tmpl-id="${escapeAttr(t.id)}">
            <span class="tmpl-sheet__mark">
              <i data-icon="table" class="w-5 h-5"></i>
            </span>
            <span class="tmpl-sheet__text">
              ${escapeHtml(t.title || "Untitled grid")}
              <span class="tmpl-sheet__meta">${n} row${n === 1 ? "" : "s"}${escapeHtml(from)}</span>
            </span>
            <span class="tmpl-sheet__tick">
              ${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}
            </span>
          </button>
        `;
      }).join("");

      // "Plain rounds" is a real option, not a cancel: clearing a template is
      // non-destructive (the rows and the scores stay, only the labels go), so
      // it belongs in the list beside the templates rather than behind a
      // separate control.
      const none = `
        <button type="button" role="option" aria-selected="${this._activeId ? "false" : "true"}"
                class="tmpl-sheet__row ${this._activeId ? "" : "tmpl-sheet__row--on"}"
                data-tmpl-id="__none__">
          <span class="tmpl-sheet__mark"><i data-icon="list" class="w-5 h-5"></i></span>
          <span class="tmpl-sheet__text">
            Plain rounds
            <span class="tmpl-sheet__meta">R1, R2, R3… — add rows as you go</span>
          </span>
          <span class="tmpl-sheet__tick">
            ${this._activeId ? "" : `<i data-icon="check" class="w-4 h-4"></i>`}
          </span>
        </button>
      `;

      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Scoring template</h3>
          <p class="bgb-sheet__sub">From your reference guide for this game</p>
          <div class="bgb-sheet__list" role="listbox" aria-label="Scoring template"
               data-tmpl-list>
            ${rows}${none}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }
  }

  window.BgbScoringTemplateSheet = new ScoringTemplateSheet();
})();
