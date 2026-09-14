// @ts-check
// widgets/scoring-template-sheet.js — "this game has scoring grids you have
// not adopted; want one?"
//
// ONE QUESTION, asked once per GAME on the table. offer() opens when the host
// has no scoring grid in their guide for a game that has some — once on the
// Play step (views/play-flow-view.js#_maybeOfferTemplates) and from the
// reference guide's own notice (widgets/reference-guide-scroll.js). It cannot
// be answered without SEEING the rows, so each candidate draws its real grid
// rather than a one-line summary of it.
//
// A PLAY IS SEVERAL GAMES. The chapter pool is fetched for the base game and
// every expansion on the table in one request, so what arrives is several
// games' grids in one popularity-sorted list — and three cards drawn from
// three different boxes make the host answer about a grid without being told
// which box it came out of. So the offer is a QUEUE: one step per game
// (domain/scoring-template.js#groupByGame), base game first and then the
// expansions in the order compose() will stack their rows, with a "2 of 3"
// counter so the host can see how many questions are left. A host with an
// unadopted base grid and two unadopted expansion grids answers three
// questions in one pass instead of one merged question about all three.
//
// The queue advances IN PLACE rather than closing and reopening. A close per
// step would spend a back-guard history entry, a scroll lock and a focus
// return per game (.claude/rules/overlays.md §8b), and would flash the screen
// underneath between questions.
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
// The thumbs-down is the one answer that does NOT move the queue on by itself:
// three grids you do not want are three refusals, and being asked again next
// round about the two you did not reach is the bug this feature exists to fix.
// See offer().
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

  /**
   * @typedef {Object} OfferStep One game's question, as built by
   *   domain/scoring-template.js#groupByGame.
   * @property {string} gameId
   * @property {string} gameName  already short-named against the base game
   * @property {TemplateChapter[]} templates
   */

  // How many candidates one STEP shows. A SAMPLE, not the pool: each one draws
  // a real grid, and the host is standing at a table with the game already set
  // up. The pool arrives sorted by popularity, so three is the three most
  // players use; the rest stay one tap away in the reference guide, which is
  // where browsing belongs. Per step rather than per queue — a play with two
  // expansions asks three short questions, not one nine-card one.
  const OFFER_MAX = 3;

  // How many of a candidate's rows the preview draws. Cropped in JS rather
  // than clamped in CSS: a height clamp cannot tell a grid it cut short from
  // one that simply fits, so it either fades every preview or lies about the
  // long ones. Slicing the rows means the picture is a true picture of the
  // rows it shows, and the count under it says what is missing.
  const PREVIEW_ROWS = 5;

  class ScoringTemplateSheet {
    constructor() {
      /** Every game still to be asked about, in order. @type {OfferStep[]} */
      this._steps = [];
      /** Which of them is on screen. */
      this._stepIndex = 0;
      /** The three on screen. @type {TemplateChapter[]} */
      this._templates = [];
      /** Every candidate in the CURRENT step, so a dislike can re-slice the
       *  three from what is left rather than shrinking the list.
       *  @type {TemplateChapter[]} */
      this._pool = [];
      /** The play's BASE game, so an expansion's grid can be badged with the
       *  mode it would act in — the one thing about an unfamiliar grid that
       *  changes what adopting it does to the table. */
      /** @type {string|null} */
      this._baseGameId = null;
      // The base game's NAME, for stripping it off the front of an expansion's
      // ("Everdell: Pearlbrook" -> "Pearlbrook"). Separate from the id because
      // the id answers a different question — modeTag asks it which grids are
      // expansions at all — and a caller can know one without the other.
      this._baseGameName = "";
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
     * The offer: these games HAVE scoring grids and the host has adopted none
     * of them.
     *
     * THREE answers per step, and only one of them ends the sheet outright.
     * "Use this one" and "Continue without" are both answers the caller
     * records, so the host is not asked again next round — and on any step but
     * the last they ADVANCE to the next game rather than closing, which is what
     * makes the queue a queue. A thumbs-down is the third: it turns ONE grid
     * down for good (migration 033) and leaves the step standing, so a host
     * looking at three grids they do not want can say so about each of them in
     * one pass. The card goes the moment it is tapped; when the last one on a
     * step goes there is nothing left to ask about that game and the queue
     * moves on by itself.
     *
     * Backdrop, Escape and the device back gesture are the remaining exit and
     * mean none of the three, for the WHOLE queue: they close the sheet and
     * leave every remaining question open for next time
     * (.claude/rules/overlays.md §8 — four exits, one meaning, and that meaning
     * here is "not now"), which is why `onSkip` fires from the button rather
     * than from onClose.
     *
     * NO FETCH here, per this file's header: `onDislike` hands the grid to the
     * caller and the caller does the write. The sheet only stops drawing it.
     *
     * @param {{steps: OfferStep[], returnFocus?: Element|null,
     *          baseGameId?: string|null, baseGameName?: string|null,
     *          onAdopt: (t: TemplateChapter) => void,
     *          onSkip: (shown: TemplateChapter[]) => void,
     *          onDislike?: (t: TemplateChapter) => void}} opts
     */
    offer(opts) {
      // Steps with nothing drawable in them are dropped HERE rather than
      // trusted out of the caller: an empty step would render a headed panel
      // with no cards under it, and "2 of 3" would be counting a question
      // nobody can answer.
      const steps = (opts.steps || []).filter(
        (s) => s && (s.templates || []).some(
          (t) => t.grid && Array.isArray(t.grid.rows) && t.grid.rows.length
        )
      );
      if (!steps.length) return;

      this._steps = steps;
      this._stepIndex = 0;
      this._baseGameId = opts.baseGameId || null;
      this._baseGameName = opts.baseGameName || "";
      this._onPick = opts.onAdopt;
      this._onSkip = opts.onSkip;
      this._onDislike = opts.onDislike || null;
      this._seedStep();

      this._sheet.open({
        html: this._renderOfferPanel(),
        label: "Scoring templates for this play",
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
        onOpen: () => this._focusFirst(),
      });
    }

    close() { this._sheet.close(); }

    /** The game currently being asked about. @returns {OfferStep|null} */
    _step() { return this._steps[this._stepIndex] || null; }

    /** Is this the last question in the queue? */
    _isLast() { return this._stepIndex >= this._steps.length - 1; }

    /**
     * Load the current step's candidates.
     *
     * Sorted here, not trusted. The pool arrives popularity-first from the
     * backend and neither pendingTemplates nor groupByGame reorders it, so this
     * is usually a no-op — but OFFER_MAX below throws the rest away, and "the
     * three most players use" has to be true of the three that survive rather
     * than of whatever order the caller happened to hand over (a cache seeded
     * by an older response, a future caller that merges lists). Array#sort is
     * stable, so ties keep the pool's own created_at DESC.
     *
     * `_pool` keeps the WHOLE candidate list for this step, not just the three
     * shown. It is what a dislike re-slices against, so turning one of the
     * three down promotes the next-most-popular into the gap rather than
     * leaving two cards and a grid nobody was offered.
     */
    _seedStep() {
      const step = this._step();
      this._pool = ((step && step.templates) || [])
        .slice()
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      this._templates = this._pool.slice(0, OFFER_MAX);
    }

    /**
     * On to the next game — or out, when there is no next game.
     *
     * The step index walks forward past anything that has emptied out (every
     * grid disliked) rather than stopping on it, so the queue never parks on a
     * question with no answers.
     */
    _advance() {
      for (let i = this._stepIndex + 1; i < this._steps.length; i++) {
        this._stepIndex = i;
        this._seedStep();
        if (this._templates.length) { this._patch(); this._focusFirst(); return; }
      }
      this._sheet.close();
    }

    /**
     * "Continue without" on the last question, "Skip this one" before it.
     *
     * Either way it is an ANSWER about this game and the caller records it, by
     * the ids actually SHOWN — the ones the sample left out were never put to
     * the host, so they stay pending. Only the last one closes the sheet;
     * before that the queue simply moves on, which is the difference between
     * declining Everdell's grids and declining the whole table's.
     */
    _skip() {
      const shown = this._templates.slice();
      const onSkip = this._onSkip;
      if (this._isLast()) {
        this._sheet.close();
        if (onSkip) onSkip(shown);
        return;
      }
      if (onSkip) onSkip(shown);
      this._advance();
    }

    _pick(id) {
      const picked = this._templates.find((t) => t.id === id) || null;
      if (!picked) return;
      if (this._isLast()) {
        // Close first: the host's grid repaints behind the sheet, and applying
        // a template can change its row count, so the sheet coming down first
        // is what makes the change read as "the table I just chose".
        this._sheet.close();
        if (this._onPick) this._onPick(picked);
        return;
      }
      // Mid-queue there is nothing to reveal yet — the sheet is staying up for
      // the next question — so the adoption goes through first and the next
      // step takes its place. The table underneath is repainted by the caller
      // either way, and the host sees it when the queue ends.
      if (this._onPick) this._onPick(picked);
      this._advance();
    }

    /**
     * Turn one grid down, and stay on this question.
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

      // Nothing left to choose between for THIS game, so it has no question to
      // ask and the queue moves on (closing, if it was the last). It does so
      // WITHOUT onSkip: skipping is "not these, not now" and would have the
      // caller write a per-device dismissal, where these grids are already
      // turned down for good on the server. Asking the caller to record a
      // second, weaker refusal on top would be recording the same decision
      // twice.
      if (!this._templates.length) this._advance();
      else this._patch();

      if (this._onDislike) this._onDislike(turned);
    }

    /**
     * Put focus on the first candidate's own button.
     *
     * Nothing here is a text input — the offer has no field at all — so this is
     * simply the first thing a screen reader should meet after the dialog's
     * label (.claude/rules/overlays.md §5). Called on open and on every step
     * change, but only when focus has actually fallen through to <body> (the
     * button that was tapped went with its card): never stolen from the Skip
     * button a host is working their way down the queue with, or from wherever
     * they have since moved.
     */
    _focusFirst() {
      const root = this._sheet.el;
      if (!root) return;
      if (root.contains(document.activeElement)
          && document.activeElement !== document.body) return;
      const first = /** @type {HTMLElement|null} */ (
        root.querySelector("[data-tmpl-id]")
      );
      if (first) first.focus();
    }

    /**
     * Repaint the four regions a dislike or a step change touches — the step
     * counter, the count line, the candidate list and the cancel button's
     * label — and nothing else.
     *
     * Not the panel. There is no text input to destroy here, but a panel
     * repaint would drop focus on its way past, and the grip and the title do
     * not change between steps (the game's name rides in the count line, where
     * it can ellipsise without taking the question with it). Four hosts rather
     * than one for the same reason widgets/reference-guide-scroll.js#
     * _paintNotice has two: they sit in different places in the panel, and the
     * one in the middle is the scrollport.
     */
    _patch() {
      const root = this._sheet.el;
      if (!root) return;
      const step = root.querySelector("[data-tmpl-step]");
      const sub = root.querySelector("[data-tmpl-sub]");
      const list = root.querySelector("[data-tmpl-list]");
      const skip = root.querySelector("[data-tmpl-skip-label]");
      if (step) step.textContent = this._stepText();
      if (sub) sub.innerHTML = this._subText();
      if (list) list.innerHTML = this._renderCards();
      if (skip) skip.textContent = this._skipLabel();
      window.BgbIcons.render(root);   // every innerHTML patch re-hydrates icons
      // A step change scrolls the list back to the top: the new game's cards
      // start at the top of the scrollport, not wherever the last game's third
      // card had been dragged to.
      if (list) list.scrollTop = 0;
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
     * Split into hosts — counter, count line, cards, cancel label — because a
     * dislike or a step change repaints those and must not touch the rest
     * (see _patch).
     *
     * The counter is rendered only for a real queue: on a single-game offer
     * there is no "1 of 1" to report and the panel reads exactly as it did
     * before this file grew steps. `aria-live` on it is what announces the move
     * to the next game, since the dialog's own label is read once on open.
     */
    _renderOfferPanel() {
      const multi = this._steps.length > 1;
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          ${multi
            ? `<p class="tmpl-offer__step" data-tmpl-step aria-live="polite">${this._stepText()}</p>`
            : ""}
          <h3 class="bgb-sheet__title">Score on a shared grid?</h3>
          <p class="bgb-sheet__sub" data-tmpl-sub>${this._subText()}</p>
          <div class="bgb-sheet__list tmpl-offer" data-tmpl-list>
            ${this._renderCards()}
          </div>
          <button class="bgb-sheet__cancel" type="button" data-tmpl-skip>
            <span data-tmpl-skip-label>${this._skipLabel()}</span>
          </button>
        </div>
      `;
    }

    /** "2 of 3" — which question this is, out of how many the host has left. */
    _stepText() {
      return `${this._stepIndex + 1} of ${this._steps.length}`;
    }

    /**
     * Skipping one question is not skipping the offer, and the button has to
     * say which it is doing — a "Continue without" that silently asks about
     * the next box reads as a control that did not work.
     */
    _skipLabel() {
      return this._isLast() ? "Continue without" : "Skip this one";
    }

    /**
     * The count line, and the only place the step's GAME is named.
     *
     * Reads `_pool`, so turning a grid down re-counts: for this viewer it is no
     * longer one of the grids written for this game, and a line that still said
     * "3" over two cards would be counting a refusal.
     */
    _subText() {
      const total = this._pool.length;
      const step = this._step();
      const name = (step && step.gameName) || "";
      // "for this game" is the fallback rather than a bare sentence: a grid
      // whose game the pool never named still belongs to something, and the
      // wording is what the single-game offer has always said.
      const who = name ? `for ${escapeHtml(name)}` : "for this game";
      return `
        ${total === 1
          ? `Someone has written a scoring grid ${who}.`
          : `${total} scoring grids have been written ${who}.`}
        Pick one and it joins your reference guide, ready for next time.
      `;
    }

    _renderCards() {
      const shown = this._templates;
      const more = this._pool.length - shown.length;
      const cards = shown.map((t, i) => {
        const rows = (t.grid && t.grid.rows) || [];
        const pop = t.popularity || 0;
        // Short-named, the same way the scoring bar's pills and chips name the
        // same expansions two taps away (.claude/rules/ui-object-design.md §2)
        // — this sheet is opened FROM that bar, and one box called two
        // different things across the gap is the drift that rule is about.
        const fromName = window.ScoringTemplate.gameNameOf(t, this._baseGameName);
        const from = fromName ? ` · ${escapeHtml(fromName)}` : "";
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
              ${window.ScoringTemplateEditor.preview(rows.slice(0, PREVIEW_ROWS), `tmplOffer${this._stepIndex}_${i}`)}
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
