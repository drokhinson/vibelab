// @ts-check
// widgets/scoring-template-sheet.js — the two questions a scoring grid asks.
//
// open()  — pick WHICH grid this play uses. Only opens when the host has MORE
//   THAN ONE scoring-grid chapter in their guide for this game (Everdell base
//   vs. Everdell + Pearlbrook). With exactly one, play-flow-view applies it
//   silently; with none, that question does not exist.
//
// offer() — the OTHER end of the same range: the host has NONE in their guide
//   and the game has some. Opened once, on the Play step, by
//   views/play-flow-view.js#_maybeOfferTemplates. Same object, so it is one
//   widget with a mode rather than two files that drift
//   (.claude/rules/ui-object-design.md §2) — but a genuinely different question,
//   so it gets its own panel: "which of mine" is a list of one-line rows, while
//   "adopt one of these" cannot be answered without SEEING the rows, and so
//   draws each candidate's real grid.
//
// Which one, and nothing else. Whether a template is on the table at all is the
// switch on the scoring card's template bar — one control, one question, per
// .claude/rules/ui-object-design.md §3b. This sheet used to carry a "Plain
// rounds" row as a third option, which was the same action reachable two ways
// and, once the bar grew a switch, a row that turned the switch off from inside
// a sheet the host had opened to choose a grid.
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
   * @property {string} [created_by]
   * @property {string} [created_by_name]
   * @property {number} [popularity]   chapter-pool only: how many guides hold it
   * @property {boolean} [in_my_guide] chapter-pool only
   */

  const LIST_SEL = "[data-tmpl-list]";

  // How many candidates the offer shows. A SAMPLE, not the pool: each one draws
  // a real grid, and the host is standing at a table with the game already set
  // up. The pool arrives sorted by popularity, so three is the three most
  // players use; the rest stay one tap away in the reference guide, which is
  // where browsing belongs.
  const OFFER_MAX = 3;

  // How many of a candidate's rows the preview draws. Cropped in JS rather
  // than clamped in CSS: a height clamp cannot tell a grid it cut short from
  // one that simply fits, so it either fades every preview or lies about the
  // long ones. Slicing the rows means the picture is a true picture of the
  // rows it shows, and the count under it says what is missing.
  const PREVIEW_ROWS = 5;

  class ScoringTemplateSheet {
    constructor() {
      /** @type {TemplateChapter[]} */
      this._templates = [];
      /** @type {string|null} */
      this._activeId = null;
      this._onPick = /** @type {any} */ (null);
      this._onSkip = /** @type {any} */ (null);

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
     *          onPick: (t: TemplateChapter) => void}} opts
     */
    open(opts) {
      this._templates = opts.templates || [];
      this._activeId = opts.activeId || null;
      this._onPick = opts.onPick;
      this._onSkip = null;

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

    /**
     * The offer: this game HAS scoring grids and the host has adopted none.
     *
     * Two answers, and both of them are answers — "Add one" and "Continue
     * without" both close the sheet on a decision the caller then records, so
     * the host is not asked again next round. Backdrop, Escape and the device
     * back gesture are the third exit and mean neither: they close the sheet
     * and leave the question open for next time (.claude/rules/overlays.md §8
     * — four exits, one meaning, and that meaning here is "not now"), which is
     * why `onSkip` fires from the button rather than from onClose.
     *
     * @param {{templates: TemplateChapter[], returnFocus?: Element|null,
     *          onAdopt: (t: TemplateChapter) => void,
     *          onSkip: (shown: TemplateChapter[]) => void}} opts
     */
    offer(opts) {
      this._templates = (opts.templates || []).slice(0, OFFER_MAX);
      this._activeId = null;
      this._onPick = opts.onAdopt;
      this._onSkip = opts.onSkip;
      const total = (opts.templates || []).length;

      this._sheet.open({
        html: this._renderOfferPanel(total),
        label: "Scoring templates for this game",
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest("[data-tmpl-skip]")) { this._skip(); return; }
          const use = e.target.closest("[data-tmpl-id]");
          if (use) this._pick(use.dataset.tmplId);
        },
        onOpen: (root) => {
          // The first candidate's own button. Nothing here is a text input —
          // the offer has no field at all — so this is simply the first thing
          // a screen reader should meet after the dialog's label
          // (.claude/rules/overlays.md §5).
          const first = /** @type {HTMLElement|null} */ (
            root.querySelector("[data-tmpl-id]")
          );
          if (first) first.focus();
        },
      });
    }

    close() { this._sheet.close(); }

    /** "Continue without" — an answer, and the caller records it as one. */
    _skip() {
      const shown = this._templates.slice();
      const onSkip = this._onSkip;
      this._sheet.close();
      if (onSkip) onSkip(shown);
    }

    _pick(id) {
      const picked = this._templates.find((t) => t.id === id) || null;
      if (!picked) return;
      // Close first: the host's grid repaints behind the sheet, and applying a
      // template can change its row count, so the sheet coming down first is
      // what makes the change read as "the table I just chose".
      this._sheet.close();
      if (this._onPick) this._onPick(picked);
    }

    _renderPanel() {
      // Every grid for one game carries the SAME derived title (the game's name
      // plus "scoring" — services/chapter_grid.grid_title), because a grid is
      // not named by its author. So the row leads with WHO wrote it, which is
      // the thing that actually tells two of them apart, and the title never
      // appears here at all.
      const rows = this._templates.map((t) => {
        const on = t.id === this._activeId;
        const n = ((t.grid && t.grid.rows) || []).length;
        const from = t.source_game_name
          ? ` · ${t.source_game_name}`
          : "";
        const who = this._authorLabel(t);
        return `
          <button type="button" role="option" aria-selected="${on ? "true" : "false"}"
                  class="tmpl-sheet__row ${on ? "tmpl-sheet__row--on" : ""}"
                  data-tmpl-id="${escapeAttr(t.id)}">
            <span class="tmpl-sheet__mark">
              <i data-icon="table" class="w-5 h-5"></i>
            </span>
            <span class="tmpl-sheet__text">
              ${escapeHtml(who)}
              <span class="tmpl-sheet__meta">${n} row${n === 1 ? "" : "s"}${escapeHtml(from)}</span>
            </span>
            <span class="tmpl-sheet__tick">
              ${on ? `<i data-icon="check" class="w-4 h-4"></i>` : ""}
            </span>
          </button>
        `;
      }).join("");

      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Scoring template</h3>
          <p class="bgb-sheet__sub">From your reference guide for this game</p>
          <div class="bgb-sheet__list" role="listbox" aria-label="Scoring template"
               data-tmpl-list>
            ${rows}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
        </div>
      `;
    }

    /**
     * Who wrote this grid — the one thing that actually tells two of them
     * apart, since every grid for one game carries the same derived title.
     * @param {TemplateChapter} t
     */
    _authorLabel(t) {
      const me = window.store && window.store.get && window.store.get("user");
      if (me && t.created_by && me.id === t.created_by) return "Your grid";
      return t.created_by_name ? `${t.created_by_name}'s grid` : "Community grid";
    }

    /**
     * The offer panel. Each candidate is a CARD, not a row: the row form above
     * says "6 rows · Everdell", which is not enough to choose between two
     * scorepads with your friends waiting — so each one draws its real grid,
     * through the same ScoringTemplateEditor.preview the guide and the author's
     * own editor use (.claude/rules/ui-object-design.md §2).
     *
     * A card is a <div> with its own button inside it, rather than one big
     * <button>: a row carrying a description renders a note button of its own
     * inside the preview, and a button cannot contain a button — the parser
     * closes the outer one early and the card falls apart. The preview is
     * inert anyway (`.tmpl-preview .scoring-table-wrap` is pointer-events:
     * none), so the Add button is the whole tap target and says what it does.
     *
     * @param {number} total how many were pending before the OFFER_MAX slice
     */
    _renderOfferPanel(total) {
      const shown = this._templates;
      const more = total - shown.length;
      const cards = shown.map((t, i) => {
        const rows = (t.grid && t.grid.rows) || [];
        const pop = t.popularity || 0;
        const from = t.source_game_name ? ` · ${escapeHtml(t.source_game_name)}` : "";
        const used = pop > 0 ? ` · in ${pop} guide${pop === 1 ? "" : "s"}` : "";
        const hidden = Math.max(0, rows.length - PREVIEW_ROWS);
        return `
          <div class="tmpl-offer__card">
            <div class="tmpl-offer__head">
              <span class="tmpl-offer__who">${escapeHtml(this._authorLabel(t))}</span>
              <span class="tmpl-offer__meta">${rows.length} row${rows.length === 1 ? "" : "s"}${used}${from}</span>
            </div>
            <div class="tmpl-preview tmpl-offer__preview" aria-hidden="true">
              ${window.ScoringTemplateEditor.preview(rows.slice(0, PREVIEW_ROWS), `tmplOffer${i}`)}
              ${hidden ? `<span class="tmpl-offer__rest">+${hidden} more row${hidden === 1 ? "" : "s"}</span>` : ""}
            </div>
            <button type="button" class="tmpl-offer__use"
                    data-tmpl-id="${escapeAttr(t.id)}">
              <i data-icon="plus" class="w-4 h-4"></i>
              Use this one
            </button>
          </div>
        `;
      }).join("");

      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Score on a shared grid?</h3>
          <p class="bgb-sheet__sub">
            ${total === 1
              ? "Someone has written a scoring grid for this game."
              : `${total} scoring grids have been written for this game.`}
            Pick one and it joins your reference guide, ready for next time.
          </p>
          <div class="bgb-sheet__list tmpl-offer" data-tmpl-list>
            ${cards}
            ${more > 0
              ? `<p class="tmpl-offer__more">${more} more in your reference guide.</p>`
              : ""}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-tmpl-skip>
            Continue without
          </button>
        </div>
      `;
    }
  }

  window.BgbScoringTemplateSheet = new ScoringTemplateSheet();
})();
