// @ts-check
// widgets/scoring-template-sheet.js — "this game has scoring grids you have
// not adopted; want one?"
//
// ONE QUESTION, asked in one place. offer() opens when the host has NO scoring
// grid in their guide for a game that has some — once on the Play step
// (views/play-flow-view.js#_maybeOfferTemplates) and from the reference guide's
// own notice (widgets/reference-guide-scroll.js). It cannot be answered without
// SEEING the rows, so each candidate draws its real grid rather than a
// one-line summary of it.
//
// This file used to carry a second mode, open(), for picking between the grids
// a host had ALREADY adopted. That question moved to the pill row in the
// scoring card's own bar (views/play-flow-view.js#_renderTemplatePills): two or
// three options that reshape the table directly beneath them want to be visible
// beside it, not behind a sheet covering the very grid they change. The sheet
// stays for the offer, where the choice is between things the host has never
// seen and each option needs a picture.
//
// Whether a template is on the table at all is neither question — that is the
// switch on the same bar, one control per question per
// .claude/rules/ui-object-design.md §3b.
//
// NO FETCH — and that holds for the thumbs-down too. The candidates come from
// the reference-guide scroll's own pool load, handed over on the
// `guide-templates-loaded` event — the same list the host can see behind this
// sheet, which is what stops the sheet and the guide disagreeing about what is
// in it. Turning one down is the same division of labour: the sheet stops
// drawing the card, `onDislike` hands the grid to whoever opened the sheet, and
// that caller does the write and owns what else has to change because of it
// (the guide reloads its lists; the play screen must not, with a scorepad
// underneath).
//
// The thumbs-down is the one answer that does NOT close the sheet: three grids
// you do not want are three refusals, and being asked again next round about
// the two you did not reach is the bug this feature exists to fix. See offer().
//
// Its class is named in the theme re-point list in styles.css; a body-level
// sheet lands outside the screen that opened it (.claude/rules/theming.md §8).

(function () {
  /**
   * @typedef {Object} TemplateChapter
   * @property {string} id
   * @property {string} title
   * @property {{rows: Array<{label: string, color: string}>, mode?: string|null}} grid
   * @property {string} [source_game_name]
   * @property {string} [created_by]
   * @property {string} [created_by_name]
   * @property {number} [popularity]   chapter-pool only: how many guides hold it
   * @property {boolean} [in_my_guide] chapter-pool only
   * @property {boolean} [disliked]    chapter-pool only: the viewer has turned
   *   this grid down (migration 033). Never true on anything that reaches this
   *   sheet — Chapter.pendingTemplates filters them out upstream — but the
   *   flag rides on the rows, so the shape says so.
   */

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
      /** The three on screen. @type {TemplateChapter[]} */
      this._templates = [];
      /** Every candidate the caller offered, so a dislike can re-slice the
       *  three from what is left rather than shrinking the list.
       *  @type {TemplateChapter[]} */
      this._pool = [];
      /** The play's BASE game, so an expansion's grid can be badged with the
       *  mode it would act in — the one thing about an unfamiliar grid that
       *  changes what adopting it does to the table. */
      /** @type {string|null} */
      this._baseGameId = null;
      this._onPick = /** @type {any} */ (null);
      this._onSkip = /** @type {any} */ (null);
      this._onDislike = /** @type {any} */ (null);

      this._sheet = new window.BgbBottomSheet({
        id: "bgb-scoring-template-sheet",
        className: "tmpl-sheet",
        label: "Scoring template",
      });
    }

    get isOpen() { return this._sheet.isOpen; }

    /**
     * The offer: this game HAS scoring grids and the host has adopted none.
     *
     * THREE answers now, and they do not all end the sheet. "Use this one" and
     * "Continue without" both close it on a decision the caller records, so the
     * host is not asked again next round. A thumbs-down is the third: it turns
     * ONE grid down for good (migration 033) and leaves the sheet standing, so
     * a host looking at three grids they do not want can say so about each of
     * them in one pass rather than being asked again next round about the two
     * they did not get to. The card goes the moment it is tapped; when the last
     * one goes there is nothing left to offer and the sheet closes itself.
     *
     * Backdrop, Escape and the device back gesture are the remaining exit and
     * mean none of the three: they close the sheet and leave the question open
     * for next time (.claude/rules/overlays.md §8 — four exits, one meaning,
     * and that meaning here is "not now"), which is why `onSkip` fires from the
     * button rather than from onClose.
     *
     * NO FETCH here, per this file's header: `onDislike` hands the grid to the
     * caller and the caller does the write. The sheet only stops drawing it.
     *
     * @param {{templates: TemplateChapter[], returnFocus?: Element|null,
     *          baseGameId?: string|null,
     *          onAdopt: (t: TemplateChapter) => void,
     *          onSkip: (shown: TemplateChapter[]) => void,
     *          onDislike?: (t: TemplateChapter) => void}} opts
     */
    offer(opts) {
      this._baseGameId = opts.baseGameId || null;
      // Sorted here, not trusted. The pool arrives popularity-first from the
      // backend and pendingTemplates only filters, so this is usually a no-op —
      // but OFFER_MAX below throws the rest away, and "the three most players
      // use" has to be true of the three that survive rather than of whatever
      // order the caller happened to hand over (a cache seeded by an older
      // response, a future caller that merges lists). Array#sort is stable, so
      // ties keep the pool's own created_at DESC.
      //
      // `_pool` keeps the WHOLE candidate list, not just the three shown. It is
      // what a dislike re-slices against, so turning one of the three down
      // promotes the next-most-popular into the gap rather than leaving two
      // cards and a grid nobody was offered.
      this._pool = (opts.templates || [])
        .slice()
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      this._templates = this._pool.slice(0, OFFER_MAX);
      this._onPick = opts.onAdopt;
      this._onSkip = opts.onSkip;
      this._onDislike = opts.onDislike || null;

      this._sheet.open({
        html: this._renderOfferPanel(),
        label: "Scoring templates for this game",
        returnFocus: opts.returnFocus || null,
        onClick: (e) => {
          if (e.target.closest("[data-tmpl-skip]")) { this._skip(); return; }
          // Asked BEFORE the use button: the two live in one row and a
          // `closest` for the card's id would match from inside either.
          const no = e.target.closest("[data-tmpl-dislike]");
          if (no) { this._dislike(no.getAttribute("data-tmpl-dislike")); return; }
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

    /**
     * Turn one grid down, and stay open.
     *
     * The card goes immediately and the write flows through the caller behind
     * it (.claude/rules/web-frontend.md, "Mutations feel instantaneous"). There
     * is no undo on this surface by design: the durable record is server-side,
     * and the way back is the Turned-down section in the reference guide
     * builder, which is where a list of things you have set aside belongs.
     *
     * Dropped from `_pool` as well as from the three on screen, or the re-slice
     * below would promote it straight back into the gap it just left.
     */
    _dislike(id) {
      const idx = this._pool.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const [turned] = this._pool.splice(idx, 1);
      this._templates = this._pool.slice(0, OFFER_MAX);

      // Nothing left to choose between, so the sheet has no question to ask.
      // It closes WITHOUT onSkip: skipping is "not these, not now" and would
      // have the caller write a per-device dismissal, where these grids are
      // already turned down for good on the server. Asking the caller to
      // record a second, weaker refusal on top would be recording the same
      // decision twice.
      if (!this._templates.length) this._sheet.close();
      else this._patch();

      if (this._onDislike) this._onDislike(turned);
    }

    /**
     * Repaint the two regions a dislike changes — the candidate list and the
     * count line above it — and nothing else.
     *
     * Not the panel. There is no text input to destroy here, but a panel
     * repaint would drop focus on its way past, and the grip and title have not
     * changed. Two hosts rather than one for the same reason
     * widgets/reference-guide-scroll.js#_paintNotice has two: the count sits
     * above the scrollport and the cards inside it.
     */
    _patch() {
      const root = this._sheet.el;
      if (!root) return;
      const sub = root.querySelector("[data-tmpl-sub]");
      const list = root.querySelector("[data-tmpl-list]");
      if (sub) sub.innerHTML = this._subText();
      if (list) list.innerHTML = this._renderCards();
      window.BgbIcons.render(root);   // every innerHTML patch re-hydrates icons
      // The button that was just tapped went with its card, so focus has
      // fallen through to <body>. Put it on the first remaining candidate —
      // recovering ONLY in that case, never stealing focus from wherever the
      // user has since moved (.claude/rules/overlays.md §5).
      if (document.activeElement === document.body) {
        const first = /** @type {HTMLElement|null} */ (
          root.querySelector("[data-tmpl-id]")
        );
        if (first) first.focus();
      }
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
     * Split three ways — panel, count line, cards — because a dislike repaints
     * the last two and must not touch the first (see _patch).
     */
    _renderOfferPanel() {
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h3 class="bgb-sheet__title">Score on a shared grid?</h3>
          <p class="bgb-sheet__sub" data-tmpl-sub>${this._subText()}</p>
          <div class="bgb-sheet__list tmpl-offer" data-tmpl-list>
            ${this._renderCards()}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-tmpl-skip>
            Continue without
          </button>
        </div>
      `;
    }

    /**
     * The count line. Reads `_pool`, so turning a grid down re-counts: for this
     * viewer it is no longer one of the grids written for this game, and a line
     * that still said "3" over two cards would be counting a refusal.
     */
    _subText() {
      const total = this._pool.length;
      return `
        ${total === 1
          ? "Someone has written a scoring grid for this game."
          : `${total} scoring grids have been written for this game.`}
        Pick one and it joins your reference guide, ready for next time.
      `;
    }

    _renderCards() {
      const shown = this._templates;
      const more = this._pool.length - shown.length;
      const cards = shown.map((t, i) => {
        const rows = (t.grid && t.grid.rows) || [];
        const pop = t.popularity || 0;
        const from = t.source_game_name ? ` · ${escapeHtml(t.source_game_name)}` : "";
        const hidden = Math.max(0, rows.length - PREVIEW_ROWS);
        // The count rides BESIDE the author rather than in the meta line under
        // it, because between two grids for one game it is the tiebreaker: the
        // author says whose, the count says which one the table usually uses,
        // and the list is ordered by it. Absent at zero rather than shown as a
        // "0" — a grid nobody keeps is not a fact worth a chip.
        const popChip = pop > 0
          ? `<span class="tmpl-offer__pop"
                   title="In ${pop} player${pop === 1 ? "'s" : "s'"} reference guide${pop === 1 ? "" : "s"}">
               <i data-icon="users" class="w-3.5 h-3.5"></i>${pop}
             </span>`
          : "";
        return `
          <div class="tmpl-offer__card">
            <div class="tmpl-offer__head">
              <span class="tmpl-offer__who">${escapeHtml(window.ScoringTemplateEditor.authorLabel(t))}</span>
              ${popChip}
            </div>
            <span class="tmpl-offer__meta">${rows.length} row${rows.length === 1 ? "" : "s"}${from}</span>
            ${window.ScoringTemplateEditor.modeTag(t, this._baseGameId)}
            <div class="tmpl-preview tmpl-offer__preview" aria-hidden="true">
              ${window.ScoringTemplateEditor.preview(rows.slice(0, PREVIEW_ROWS), `tmplOffer${i}`)}
              ${hidden ? `<span class="tmpl-offer__rest">+${hidden} more row${hidden === 1 ? "" : "s"}</span>` : ""}
            </div>
            <div class="tmpl-offer__answers">
              <button type="button" class="tmpl-offer__use"
                      data-tmpl-id="${escapeAttr(t.id)}">
                <i data-icon="plus" class="w-4 h-4"></i>
                Use this one
              </button>
              <button type="button" class="tmpl-offer__dislike"
                      data-tmpl-dislike="${escapeAttr(t.id)}"
                      title="Stop suggesting this"
                      aria-label="Stop suggesting ${escapeAttr(window.ScoringTemplateEditor.authorLabel(t))}">
                <i data-icon="thumbs-down" class="w-5 h-5"></i>
              </button>
            </div>
          </div>
        `;
      }).join("");

      return `
        ${cards}
        ${more > 0
          ? `<p class="tmpl-offer__more">${more} more in your reference guide.</p>`
          : ""}
      `;
    }
  }

  window.BgbScoringTemplateSheet = new ScoringTemplateSheet();
})();
