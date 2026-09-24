// widgets/reference-guide-scroll.js — shared parchment-scroll widget.
//
// Used by both Game Detail (single game) and Log Play (base game + active
// expansions). Owns its own state and renders into a host container element.
// When `gameIds` has more than one entry, the merged my-chapters fetch tags
// each row with source_color so the colored dot can tie it back to its
// expansion.

(function () {
  // Which scoring-grid chapters this viewer has already turned down lives in
  // domain/chapter.js (Chapter.pendingTemplates / Chapter.dismissTemplates) —
  // it used to be private to this widget, and moved out when the play cascade
  // grew an offer of its own reading the same answer. See the note there.

  // A scoring grid is a chapter of a different kind, and it is drawn LAST,
  // in its own Scoring section, never in the type-ordered flow above it.
  //
  // It used to be drawn in that flow, and by migration 021's display_order it
  // came FIRST — a table pushing the rules somebody actually opened the scroll
  // for below the fold. It was then dropped from this widget entirely, which
  // overshot: on the Play screen the grid is indeed two cards up in the
  // scorepad, but on a game's own page there is no scorepad, and "what do we
  // score on" is exactly the kind of thing the guide is opened for.
  //
  // So both ends are handled by where it sits and by one flag: the section is
  // always last (_renderScoringSection, appended after every other section),
  // and the surface that already draws the real scorepad passes
  // `showScoringGrids: false` so it is not shown the same table twice. The
  // "a grid exists, tap to add" offer is not gated by that flag — an unadopted
  // grid is not on anyone's screen yet, which is the whole point of offering
  // it.
  function isScoringGrid(c) {
    return c.layout === "scoring_grid" || c.chapter_type === "scoring_grid";
  }

  // A rulebook link is the other chapter drawn outside the type-ordered flow
  // (migration 052), and it is drawn FIRST rather than last. The order is the
  // argument: the rulebook is the document every other chapter is a shortcut
  // around, so it heads the scroll, where the score sheet — a table you fill in
  // rather than read — sits at the foot.
  //
  // Read defensively off either column, exactly as the API's
  // services/chapter_rulebook.is_rulebook_row does: a row that is a rulebook
  // link by either measure must not end up rendered as markdown whose whole
  // body is a bare URL.
  function isRulebook(c) {
    return c.layout === "rulebook_link" || c.chapter_type === "rulebook";
  }

  // Has anybody vouched for where this link goes? Two statuses say no —
  // `pending`, where an admin was asked and has not answered, and `unlisted`,
  // where nobody was asked at all (migration 053) — and to every reader but
  // the author they are one state. The predicate is written as "not approved
  // and not denied" rather than as a list of the two, so a fifth status added
  // later is treated as unreviewed rather than silently rendered as vouched
  // for; that is the same closed reading the API's
  // services/chapter_rulebook.gate_status takes.
  //
  // A denied link never reaches a reader who is not its author, so the DENIED
  // arm is about the author's own row, where the strike-through and the "an
  // admin turned this down" note carry the state instead.
  function isUnreviewedRulebook(c) {
    const status = c && c.moderation_status;
    return status !== "approved" && status !== "denied";
  }

  /** Host of a URL, for the one-line "where this goes" under the button. */
  function linkHost(url) {
    try { return new URL(url).host; } catch (_) { return url || ""; }
  }

  /**
   * The rows of a scoring grid, or null for any other chapter. Read
   * defensively: a row cached before migration 018, and a stale layout with no
   * grid, both have to fall through to markdown rather than draw a broken
   * table (same guard as views/reference-guide-add-view.js).
   */
  function gridRows(c) {
    return (c && c.layout === "scoring_grid" && c.grid && Array.isArray(c.grid.rows) && c.grid.rows.length)
      ? c.grid.rows
      : null;
  }

  // The body of an expanded chapter. Markdown, except for a scoring grid: its
  // rows live in `grid`, and `content` holds the generated bullet mirror that
  // keeps the pool's search working — so draw the real grid, through the same
  // ScoringTemplateEditor.preview the author's editor and the offer sheet use
  // (.claude/rules/ui-object-design.md §2).
  //
  // An EXPANSION's grid gets its mode badge above the table (migration 032).
  // Without it the guide shows two scorepads for one game with nothing to say
  // that the second one either joins or supplants the first — which is the
  // whole distinction the play screen then acts on.
  function chapterBodyHtml(c, baseGameId) {
    const rows = gridRows(c);
    if (rows && window.ScoringTemplateEditor) {
      return window.ScoringTemplateEditor.modeTag(c, baseGameId)
        + window.ScoringTemplateEditor.preview(rows, `guideGrid-${c.id}`);
    }
    return window.renderMarkdown(c.content || "");
  }

  /**
   * One rolled edge of the scroll.
   *
   * A SIBLING of the sheet, never a child. The sheet carries `overflow: hidden`
   * — it is what clips the body during the roll — so a barrel drawn inside it
   * loses whatever hangs past the edge. That is exactly what the flat
   * `.scroll-panel::before/::after` bars this replaces were: 14px of barrel with
   * six of them behind the clip, which is why the scroll read as a rectangle
   * with a dark stripe rather than as a scroll.
   *
   * Paints OPEN. The live state is `.scroll-paper--rolled` on the wrapper,
   * written by _applyScrollState — see the note there for why the markup must
   * not carry it.
   *
   * A local rather than a shared module: two calls, one file. Both rolls go
   * through it so they cannot drift onto different handlers.
   *
   * @param {"top"|"bottom"} edge
   */
  function rollHtml(edge) {
    return `
      <button class="scroll-paper__roll scroll-paper__roll--${edge}" type="button"
              aria-expanded="true" aria-controls="guide-scroll-body"
              aria-label="Roll up the reference guide"
              onclick="window.referenceGuideScroll._toggleScroll()">
        <!-- The barrel is its own element so :active can compress the roll
             without squashing the arrow, and so the spin (a background-position
             shift) is independent of the button's own box. -->
        <span class="scroll-paper__barrel" aria-hidden="true"></span>
        <span class="scroll-paper__chev" aria-hidden="true">
          <i data-icon="chevron-down" class="w-3.5 h-3.5"></i>
        </span>
      </button>
    `;
  }

  class ReferenceGuideScroll {
    /**
     * @param {Object} opts
     * @param {boolean} [opts.showScoringGrids=true] draw the adopted scoring
     *   grids in the Scoring section. Pass false on a screen that already
     *   renders the live scorepad (the Play cascade, the session viewer) —
     *   there the same table two cards apart is a duplicate, not a reference.
     *   The "a grid exists for this game" offer is unaffected either way.
     * @param {boolean} [opts.showRulebook=true] draw the Rulebook section
     *   (migration 052). There is no surface that needs it off today — the
     *   game page and both cascade screens all want it, and it is THE place the
     *   link lives since 052 took it off the game row. The flag exists so a
     *   future screen that shows the link itself can turn the section off
     *   rather than showing it twice, which is the rule
     *   .claude/rules/ui-object-design.md §3b states.
     */
    constructor({ gameIds, baseGameId, expansionMeta, onAfterMutate, defaultOpen = true, gameImage = null,
                  showScoringGrids = true, showRulebook = true } = {}) {
      this._baseGameId = baseGameId || (gameIds && gameIds[0]) || null;
      this._gameIds = (gameIds && gameIds.length) ? gameIds.slice() : (this._baseGameId ? [this._baseGameId] : []);
      this._expansionMeta = expansionMeta || {};
      this._onAfterMutate = onAfterMutate || (() => {});
      this._showScoringGrids = showScoringGrids !== false;
      this._showRulebook = showRulebook !== false;
      // Set once the scoring-grid pool has actually been fetched — see
      // _fetchTemplates. Until then "this game has no grid" is unknown, not false.
      this._templatesLoaded = false;
      // Base game's cover art — shown (pulsing) while chapters load.
      this._gameImage = gameImage || null;

      this._container = null;
      this._scrollOpen = !!defaultOpen;
      this._chapters = [];
      this._loading = false;
      this._search = "";
      // Scoring-grid chapters that EXIST for this game, adopted or not
      // (migration 018). Drives the "templates available" notice.
      this._templates = [];
      // The rulebook links this viewer is allowed to see for this game
      // (migration 052), and whether that answer has actually landed. Same
      // split as _templatesLoaded above and for the same reason: an empty list
      // before the fetch is silence, and "no rulebook link available" is a
      // CLAIM — printing it while the request is still out would flash the one
      // sentence that is worst to be wrong about.
      this._rulebooks = [];
      this._rulebooksLoaded = false;
      // How many chapters exist for this game at all — the denominator of the
      // Edit-chapters button. `null` is "not known yet", which is a different
      // thing from 0 ("nobody has written one"), exactly as _templatesLoaded
      // above separates those two for grids. _poolCountKey is the game scope
      // the number in hand was counted for.
      this._poolTotal = null;
      this._poolCountKey = null;
      // Bind once so the global window.referenceGuideScroll handle stays
      // pointed at the active widget for inline `onclick` handlers.
      window.referenceGuideScroll = this;
    }

    mount(containerEl) {
      // Each parent re-render replaces the DOM, so update the container
      // reference and re-render with the widget's existing in-memory state
      // (scroll-open, search, chapters). Only fetch on the first mount —
      // setGameIds + refresh handle subsequent reloads explicitly.
      this._container = containerEl;
      window.referenceGuideScroll = this;
      this._render();
      if (!this._fetchedOnce && this._baseGameId) {
        this._fetchedOnce = true;
        this._fetch();
      }
    }

    setGameIds(gameIds) {
      const next = (gameIds && gameIds.length) ? gameIds.slice() : [this._baseGameId];
      const changed = next.length !== this._gameIds.length
        || next.some((id, i) => id !== this._gameIds[i]);
      this._gameIds = next;
      if (changed) this._fetch();
    }

    setExpansionMeta(meta) {
      this._expansionMeta = meta || {};
      this._render();
    }

    setGameImage(url) {
      this._gameImage = url || null;
    }

    refresh() { return this._fetch(); }

    /**
     * Single-flight wrapper. An adoption reloads the scroll AND fires
     * `chapters-changed`, which the two views that mount this widget listen for
     * and answer with a refresh() of their own — so the same reload is asked
     * for twice, in the same frame, straight after the cache was invalidated.
     * Both would be live requests. Sharing the in-flight promise makes the
     * second ask free without either caller having to know about the other.
     */
    _fetch() {
      // Keyed on the game scope, so a setGameIds() mid-flight — a host ticking
      // an expansion while the guide is loading — always starts a real fetch
      // rather than being handed back the answer to the previous question.
      const key = [this._baseGameId].concat(this._gameIds).join("|");
      if (this._fetching && this._fetchKey === key) return this._fetching;
      this._fetchKey = key;
      const run = this._fetchNow().finally(() => {
        if (this._fetching === run) this._fetching = null;
      });
      this._fetching = run;
      return run;
    }

    async _fetchNow() {
      if (!this._baseGameId) return;
      this._fetchedOnce = true;
      if (!window.session) {
        this._chapters = [];
        this._render();
        // A signed-out reader has no guide, and still has a rulebook: the pool
        // endpoint takes optional auth and hands an anonymous caller the
        // APPROVED links and nothing else (migration 052). This matters for a
        // real screen rather than in theory — a guest watching a session from a
        // join code is signed out, and before 052 the link reached them on the
        // session payload.
        this._fetchRulebooks();
        return;
      }
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      // Seed instantly from the localStorage cache when present (no loader),
      // then always revalidate below so a stale list is corrected within one
      // render. Cold case: show the loader while the first fetch lands.
      let seeded = false;
      // Read through the full stale window, always. The refresh below is on
      // its way either way, and a guide cached yesterday beats a loader — or,
      // on a dead link, beats an empty scroll at the table.
      const cached = window.Chapter && window.Chapter.cachedMyChapters
        ? window.Chapter.cachedMyChapters(this._baseGameId, expansionIds, { stale: true })
        : null;
      if (cached) {
        this._chapters = cached;
        this._loading = false;
        seeded = true;
        this._announceChapters();
      } else {
        this._loading = true;
      }
      this._render();
      // No connectivity pre-check. The request is made and, when it can't
      // land, the catch below keeps the seeded chapters exactly as they are —
      // which is the same outcome the old offline branch produced, without
      // depending on a latch to reach it. Nothing is reported: the guide the
      // user is reading is on screen and is the answer.
      try {
        const fresh = await window.Chapter.myChapters(this._baseGameId, { expansionIds }) || [];
        this._chapters = fresh;
        if (window.Chapter && window.Chapter.cacheMyChapters) {
          window.Chapter.cacheMyChapters(this._baseGameId, expansionIds, fresh);
        }
      } catch (_) {
        if (!seeded) this._chapters = [];
      } finally {
        this._loading = false;
        this._announceChapters();
        this._render();
        // Deliberately after the guide's own paint, and deliberately not
        // awaited: the notice is a nudge and must never hold up the chapters
        // somebody opened the scroll to read.
        this._fetchTemplates();
        this._fetchRulebooks();
        this._fetchPoolCount();
      }
    }

    // ── The rulebook link (migration 052) ───────────────────────────────────

    /**
     * The rulebook links this viewer may see for this game.
     *
     * Same cache-then-revalidate shape as _fetchTemplates below, and fired
     * beside it for the same reason: the guide's own chapters are what somebody
     * opened the scroll to read and must not wait on this.
     *
     * The list arrives ALREADY FILTERED by the server — a pending link reaches
     * its author and their buddies and nobody else
     * (api/routes/services/chapter_rulebook.py). Nothing here re-checks that,
     * and nothing here may: a client that filtered would be filtering rows it
     * had already been handed.
     */
    async _fetchRulebooks() {
      // No `window.session` gate, unlike every other fetch on this widget: the
      // rulebook pool is the one read here that serves a signed-out caller.
      if (!this._baseGameId) return;
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      const cached = window.Chapter && window.Chapter.cachedRulebookLinks
        ? window.Chapter.cachedRulebookLinks(this._baseGameId, expansionIds, { stale: true })
        : null;
      if (cached) {
        this._rulebooks = cached;
        this._paintRulebook();
      }
      try {
        const rows = await window.Chapter.rulebookLinks(
          this._baseGameId, { expansionIds }
        ) || [];
        this._rulebooks = rows;
        if (window.Chapter.cacheRulebookLinks) {
          window.Chapter.cacheRulebookLinks(this._baseGameId, expansionIds, rows);
        }
        // Only a live answer sets this, exactly as _templatesLoaded works: "no
        // rulebook link available" is a claim, and a seeded empty array is not
        // that claim.
        this._rulebooksLoaded = true;
      } catch (_) {
        // Leave whatever the cache seeded. A guide that cannot reach the
        // network still shows yesterday's link, which at a table is the whole
        // point of the cache.
      }
      this._paintRulebook();
    }

    /**
     * THE link for this game.
     *
     * The choice lives in domain/chapter.js rather than here, even though this
     * widget is its only caller today: a game can have several links and every
     * surface that shows "the rulebook" has to pick the same one, so the moment
     * a second surface wants it the answer must already be somewhere shared.
     * There is deliberately no `guide-rulebook-loaded` event to go with the
     * scoring pool's: nothing outside this widget draws the link any more (the
     * game page's button and both cascade rows went with migration 052), and an
     * announcement nobody listens to is dead code that reads as a contract.
     */
    _currentRulebook() {
      return window.Chapter && window.Chapter.resolveRulebook
        ? window.Chapter.resolveRulebook(this._rulebooks)
        : null;
    }

    // ── "Scoring templates available" notice (migration 018) ────────────────

    async _fetchTemplates() {
      if (!this._baseGameId || !window.session) return;
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      const cached = window.Chapter && window.Chapter.cachedScoringTemplates
        ? window.Chapter.cachedScoringTemplates(this._baseGameId, expansionIds, { stale: true })
        : null;
      if (cached) {
        this._templates = cached;
        this._paintNotice();
        this._announceTemplates();
      }
      try {
        const rows = await window.Chapter.scoringTemplates(
          this._baseGameId, { expansionIds }
        ) || [];
        this._templates = rows;
        if (window.Chapter.cacheScoringTemplates) {
          window.Chapter.cacheScoringTemplates(this._baseGameId, expansionIds, rows);
        }
        // Only a live answer sets this. "This game has no scoring grid" is a
        // claim the Create affordance below is made on, and an empty
        // `_templates` before the pool has landed is not that claim — it is
        // the array the constructor seeded.
        this._templatesLoaded = true;
      } catch (_) {
        // Leave whatever the cache seeded; a missing nudge is not an error
        // worth showing anybody.
      }
      this._paintNotice();
      this._announceTemplates();
    }

    /**
     * Hand the pool over, for the same reason _announceChapters exists: the
     * play cascade wants this exact list (see play-flow-view's
     * _maybeOfferTemplates) and mounts in the same frame for the same game, so
     * fetching it there would double the request on every cold mount — and
     * would have to reimplement the stale-window seed and the revalidation
     * this method already rides.
     */
    _announceTemplates() {
      document.dispatchEvent(new CustomEvent("guide-templates-loaded", {
        detail: { gameId: this._baseGameId, templates: this._templates },
      }));
    }

    /**
     * The denominator of the button's "N of M" — how many chapters exist for
     * this game at all, adopted or not. Same cache-then-revalidate shape as
     * _fetchTemplates above, and fired beside it for the same reason: a number
     * on a button must never hold up the chapters somebody opened the scroll to
     * read.
     */
    async _fetchPoolCount() {
      if (!this._baseGameId || !window.session) return;
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      // The count is scoped to the game set, so a scope change — a host ticking
      // an expansion while the guide is loading — drops the number in hand
      // rather than leaving the previous scope's total under the new guide.
      const key = [this._baseGameId].concat(this._gameIds).join("|");
      if (this._poolCountKey !== key) {
        this._poolCountKey = key;
        this._poolTotal = null;
      }
      const cached = window.Chapter && window.Chapter.cachedPoolCount
        ? window.Chapter.cachedPoolCount(this._baseGameId, expansionIds, { stale: true })
        : null;
      if (cached !== null) {
        this._poolTotal = cached;
        this._paintAddButton();
      }
      try {
        const total = await window.Chapter.poolCount(this._baseGameId, { expansionIds });
        this._poolTotal = total;
        if (window.Chapter.cachePoolCount) {
          window.Chapter.cachePoolCount(this._baseGameId, expansionIds, total);
        }
      } catch (_) {
        // Leave whatever the cache seeded, and the plain label when it seeded
        // nothing. A button without its count still opens the same screen.
      }
      this._paintAddButton();
    }

    /**
     * Repaint the notice against the dismissal store, without re-fetching.
     * Called by the play cascade after its own offer is answered: the same
     * store backs both, so a grid turned down at the table must not still be
     * offered by the notice two cards further down the same screen.
     */
    refreshTemplateNotice() { this._paintNotice(); }

    /**
     * The chapters that go in the type-ordered flow — everything the guide
     * holds except the scoring grids, which are drawn last by their own section
     * (see isScoringGrid above). Derived on every paint rather than filtered
     * once at fetch, because `_chapters` is also what _announceChapters hands
     * the play screen, and that one wants the grids.
     */
    _visibleChapters() {
      return (this._chapters || []).filter((c) => !isScoringGrid(c) && !isRulebook(c));
    }

    /**
     * Whether the search field earns its row in the peek.
     *
     * A search field over one chapter is chrome with nothing to do: the chapter
     * is already on screen, and the field costs a row of the peek — the strip
     * that is ALL you see on the Play screen, where the scroll opens rolled up.
     * Two is where narrowing starts to mean something.
     *
     * Counted on `visible`, so the adopted scoring grids drawn by their own
     * section below do not let the field in on their own: a guide holding one
     * rule and two grids has one thing to search.
     *
     * The field going away has to take any query with it, or the list stays
     * silently filtered with nothing on screen to clear it — and the query would
     * come back the moment a second chapter did.
     *
     * A method rather than a local in _html because the answer is now a CLASS on
     * the paper (`--nosearch`) rather than a render branch, and because
     * _toggleScroll no longer re-renders: it must be knowable without one. It
     * does not need to be — it turns only on the chapter list, and every path
     * that changes that list lands in a render.
     *
     * @param {Array} [visible] the already-filtered list, when the caller has one.
     */
    _canSearch(visible) {
      const list = visible || this._visibleChapters();
      const can = list.length >= 2;
      if (!can) this._search = "";
      return can;
    }

    /** The templates this viewer has not adopted, minus any they dismissed. */
    _pendingTemplates() {
      return window.Chapter.pendingTemplates(this._templates, this._baseGameId);
    }

    /**
     * Patch the two places a pending grid can be named — the Scoring section at
     * the foot of the body, and the peek's notice — in place, rather than
     * re-rendering.
     *
     * _render() replaces the whole panel, which would destroy the search field
     * mid-keystroke along with its focus and caret — _onSearch only gets away
     * with that because it deliberately restores both afterwards.
     */
    _paintNotice() {
      if (!this._container) return;
      const hosts = [
        [this._container.querySelector("[data-scoring-host]"), this._renderScoringSection()],
        [this._container.querySelector("[data-notice-host]"), this._renderScoringCta()],
      ];
      if (!hosts.some(([host]) => host)) {
        // No host in the DOM at all: the scroll is in a state that renders none
        // (anonymous, or still loading). A full render is right if there is now
        // something to say and harmless otherwise — and it cannot be
        // mid-keystroke, because the search field only exists in a state that
        // already carries both hosts.
        if (hosts.some(([, html]) => html)) this._render();
        return;
      }
      for (const [host, html] of hosts) {
        if (!host) continue;
        host.innerHTML = html;
        window.BgbIcons.render(host);
        // The section this just replaced can carry a chapter list of its own,
        // and _render()'s pass over the lists has long since run.
        this._wireAccordion(host);
      }
      // The Scoring section just changed height under a cap that may have been
      // measured before it existed.
      this._syncOpenHeight();
    }

    /**
     * The one affordance that opens the add/browse screen. Rendered by State B's
     * empty state and again at the foot of State C's body; one renderer rather
     * than the two copies that were there, because the label is now a function
     * of two counts and two copies would drift apart.
     *
     * The counts answer the question the button could not: is there anything
     * written for this game already, or would I be authoring the first one —
     * the same question _renderCreateTemplate answers for scoring grids. Three
     * states:
     *
     *   pool size unknown → no count at all. The button paints before the count
     *     lands (and on a dead link never gets one), and "(3 of 3)" corrected to
     *     "(3 of 12)" a moment later is worse than a label that waits.
     *   pool empty        → nobody has written one; say that instead of "0 of 0".
     *   pool has chapters → "N of M", where N is the WHOLE guide including the
     *     adopted scoring grids the section directly above draws. Counting mine
     *     one way and the total another would make the ratio a lie.
     *
     * The VERB is a separate question from the count, and it is answered by the
     * guide alone: with chapters in it the screen this opens is where they are
     * edited and removed, so the button says Edit guide and carries the pencil
     * the per-chapter Edit affordance already uses. With an empty guide there is
     * nothing to edit yet, whatever the pool holds, so it stays Add with the
     * plus. Gating the verb on the POOL count instead — which is what it used to
     * do — got both ends wrong: an empty guide beside a stocked pool offered
     * "Edit chapters (0 of 12)", and a guide full of chapters whose pool count
     * never landed offered "Add a chapter".
     */
    _renderAddButton() {
      const mine = (this._chapters || []).length;
      const known = typeof this._poolTotal === "number";
      // A chapter can outlive its pool row — deleted at the source while still
      // sitting in somebody's guide — and "5 of 4" reads as a bug rather than
      // as the edge case it is.
      const total = known ? Math.max(this._poolTotal, mine) : 0;
      // The count rides INSIDE the label's span, not beside it: this button is a
      // flex row with a gap, so a sibling span would be spaced off like a third
      // column. Same trap as _expansionsHeaderLabel in views/play-flow-view.js,
      // which carries the long version of this note.
      const count = known && total > 0
        ? ` <span class="scroll-panel__add-count">(${mine} of ${total})</span>`
        : "";
      const ariaCount = known && total > 0 ? `, ${mine} of ${total} in your guide` : "";
      let icon = "plus";
      let label = "Add a chapter";
      let aria = "Add a chapter" + ariaCount;
      if (mine > 0) {
        icon = "pencil";
        label = "Edit guide";
        aria = "Edit guide" + ariaCount;
      } else if (known && total === 0) {
        label = "Write the first chapter";
        aria = "Write the first chapter for this game";
      }
      label += count;
      return `
        <button class="scroll-panel__add" type="button"
                aria-label="${escapeAttr(aria)}"
                onclick="window.referenceGuideScroll._openAddChapter()">
          <i data-icon="${icon}" class="w-4 h-4"></i>
          <span>${label}</span>
        </button>
      `;
    }

    /**
     * Patch the button in place when the count lands.
     *
     * It sits outside both hosts _paintNotice knows about, and a full _render()
     * would destroy the search field mid-keystroke along with its focus and
     * caret — the hazard documented on _paintNotice above.
     *
     * No full-render fallback, unlike _paintNotice: the one state that renders
     * no button at all is the anonymous one, which has no guide to count.
     */
    _paintAddButton() {
      if (!this._container) return;
      const host = this._container.querySelector("[data-add-host]");
      if (!host) return;
      host.innerHTML = this._renderAddButton();
      window.BgbIcons.render(host);
      // "Edit guide" → "Edit guide (3 of 12)" can change the button's height,
      // and the count lands asynchronously — including in the middle of an
      // unroll, against a cap measured before it existed.
      this._syncOpenHeight();
    }

    /**
     * The Rulebook section — always the FIRST section of the scroll.
     *
     * With no link on show it collapses to just the add affordance (plus the
     * viewer's own pending/denied row, if any) — no heading, no "none
     * available" line. The button itself answers "where are the rules".
     *
     * Silence is kept for exactly one state: before the fetch lands. An empty
     * `_rulebooks` then is not an answer (see _fetchRulebooks), and flashing
     * "none available" a beat before a link appears is worse than a blank.
     *
     * Three things can be on it, in order:
     *   * the resolved link — the one every surface agrees on
     *     (domain/chapter.js#resolveRulebook), with a badge when it is not
     *     approved yet;
     *   * the viewer's OWN link when it is not the resolved one — the only
     *     place a denial is ever visible, and the reason a denial is a status
     *     rather than a delete;
     *   * the add affordance, when there is no link or the viewer has not
     *     written one.
     */
    _renderRulebookSection() {
      if (!this._showRulebook) return "";
      if (!this._rulebooksLoaded && !(this._rulebooks || []).length) return "";

      const link = this._currentRulebook();
      const me = window.store && window.store.get("user");
      const myId = me && me.id;
      const mine = myId
        ? (this._rulebooks || []).find((r) => r.created_by === myId)
        : null;
      const mineIsShown = !!(mine && link && mine.id === link.id);

      // The author's own link, when it is not the one on show: pending behind
      // somebody else's approved link, or turned down. Nobody else is ever sent
      // this row — the server does not send them the chapter — so it is safe to
      // say plainly what happened to it.
      const mineNote = (mine && !mineIsShown) ? this._renderMyRulebookNote(mine) : "";
      const addBtn = mine || !window.session ? "" : this._renderAddRulebook(!!link);

      // No link on show: no heading and no "none available" line — just the
      // author's own row and/or the add button. Returns "" when neither applies
      // so the host stays :empty.
      if (!link) {
        const bare = `${mineNote}${addBtn}`.trim();
        return bare
          ? `<section class="scroll-section scroll-section--rulebook" data-type="rulebook">${bare}</section>`
          : "";
      }

      return `
        <section class="scroll-section scroll-section--rulebook" data-type="rulebook">
          <h4 class="scroll-section__header">
            <i data-icon="book-open" class="w-4 h-4"></i>
            Rulebook
          </h4>
          ${this._renderRulebookLink(link, myId)}
          ${mineNote}
          ${addBtn}
        </section>
      `;
    }

    /**
     * The rolled-up copy: the link, and nothing else.
     *
     * The peek is a strip, not a section — it is ALL you see on the Play
     * screen with the scroll rolled — so it carries the one thing somebody
     * mid-game reaches for and none of the chrome the open section has room
     * for: no heading (the strip sits under a card already labelled Reference
     * guide), no author line, no Report or Edit, and no Add. Adding a link is a
     * deliberate act and belongs on the open scroll; reaching the rules is not.
     *
     * It still says "No rulebook link available", because rolled up is the one
     * state where the section saying it is hidden — and silence there is the
     * ambiguity this whole section exists to remove.
     */
    _renderRulebookPeek() {
      if (!this._showRulebook) return "";
      if (!this._rulebooksLoaded && !(this._rulebooks || []).length) return "";
      const link = this._currentRulebook();
      if (!link) {
        return `<p class="scroll-rulebook__none scroll-rulebook__none--peek">No rulebook link available.</p>`;
      }
      // Unlisted and pending read the same to a reader and say the same thing
      // here: nobody has vouched for where this goes. The difference between
      // them — whether an admin was ASKED to (migration 053) — is the author's
      // business and appears on their own row below, not on a strip somebody
      // is reading mid-game.
      const unreviewed = isUnreviewedRulebook(link);
      return `
        <a class="scroll-rulebook__cta scroll-rulebook__cta--peek"
           href="${escapeAttr(link.link_url || "")}" target="_blank" rel="noopener">
          <i data-icon="book-open" class="w-4 h-4"></i>
          <span>Rulebook</span>
          ${unreviewed ? `<span class="scroll-rulebook__badge">Not reviewed yet</span>` : ""}
          <i data-icon="external-link" class="w-3.5 h-3.5"></i>
        </a>
      `;
    }

    /**
     * The link itself. An anchor, not a button that navigates: a rulebook is
     * usually a PDF somebody wants in another tab, and long-pressing a real
     * anchor is how a phone offers "open in new tab" and "copy link".
     *
     * `rel="noopener"` is not optional here and not ceremony: this is the one
     * place in the app that sends a reader to a URL a stranger typed.
     */
    _renderRulebookLink(link, myId) {
      const url = link.link_url || "";
      const unreviewed = isUnreviewedRulebook(link);
      const author = link.created_by_name
        ? `Added by ${link.created_by_name}`
        : "Added by an admin";
      // To anyone but the author the two unreviewed states are one state, and
      // the badge says the only thing that matters about both: nobody has
      // checked where this goes. The AUTHOR gets the distinction, because for
      // them it is the difference between waiting on somebody and waiting on
      // nobody — and "Waiting for approval" on a link they never submitted is
      // a queue item they would keep checking for.
      const mine = link.created_by === myId;
      const unlisted = link.moderation_status === "unlisted";
      const badgeText = mine
        ? (unlisted ? "Buddies only" : "Waiting for approval")
        : "Not reviewed yet";
      const badge = unreviewed
        ? `<span class="scroll-rulebook__badge" title="${
             mine && unlisted
               ? "Only you and your buddies can see this — edit it to ask an admin to review it"
               : "An admin has not reviewed this link yet"
           }">
             <i data-icon="${mine && unlisted ? "users" : "clock"}" class="w-3 h-3"></i>
             ${badgeText}
           </span>`
        : "";
      return `
        <div class="scroll-rulebook">
          <a class="scroll-rulebook__cta" href="${escapeAttr(url)}"
             target="_blank" rel="noopener">
            <i data-icon="book-open" class="w-4 h-4"></i>
            <span>Open the rulebook</span>
            <i data-icon="external-link" class="w-3.5 h-3.5"></i>
          </a>
          <div class="scroll-rulebook__meta">
            <span class="scroll-rulebook__host">${escapeHtml(linkHost(url))}</span>
            <span class="scroll-rulebook__by">${escapeHtml(author)}</span>
            ${badge}
          </div>
          <div class="scroll-rulebook__actions">
            ${mine ? `
              <button class="btn btn-ghost btn-xs"
                      onclick="window.referenceGuideScroll._editChapter('${link.id}', event)">
                <i data-icon="pencil" class="w-3.5 h-3.5"></i> Edit
              </button>` : `
              <button class="btn btn-ghost btn-xs"
                      onclick="window.referenceGuideScroll._reportChapter('${link.id}', event)">
                <i data-icon="flag" class="w-3.5 h-3.5"></i> Report
              </button>`}
          </div>
        </div>
      `;
    }

    /**
     * The author's own link when something else is on show, or nothing is.
     *
     * The one place a denial is ever visible, and — since migration 053 — the
     * one place an author is reminded that their link is unlisted on purpose.
     * That sentence has to say it is THEIR doing and how to undo it: an
     * unlisted link looks identical to a pending one from the outside, and an
     * author who cannot tell which they have is an author waiting on a queue
     * they are not in.
     */
    _renderMyRulebookNote(mine) {
      const status = mine.moderation_status;
      const denied = status === "denied";
      const unlisted = status === "unlisted";
      // The fourth case reaches here too, and used to fall through to
      // "waiting for approval": an author whose own link IS approved but who
      // has adopted somebody else's is shown this row, and telling them their
      // published link is still in a queue is the same wrong sentence this
      // whole change is about.
      const approved = status === "approved";
      let text;
      let icon;
      if (denied) {
        text = "An admin turned your rulebook link down. Edit it to submit a different one.";
        icon = "x";
      } else if (unlisted) {
        text = "Your rulebook link is shared with your buddies only. Edit it to ask an admin to review it.";
        icon = "users";
      } else if (approved) {
        text = "Your own rulebook link is approved — it is on this game's page for everyone.";
        icon = "check";
      } else {
        text = "Your rulebook link is waiting for approval — your buddies can see it already.";
        icon = "clock";
      }
      return `
        <p class="scroll-rulebook__mine${denied ? " scroll-rulebook__mine--denied" : ""}">
          <i data-icon="${icon}" class="w-3.5 h-3.5"></i>
          <span>${text}</span>
          <button class="btn btn-ghost btn-xs"
                  onclick="window.referenceGuideScroll._editChapter('${mine.id}', event)">
            <i data-icon="pencil" class="w-3.5 h-3.5"></i> Edit
          </button>
        </p>
      `;
    }

    /**
     * "Add a rulebook link" — offered to anyone signed in who has not written
     * one for this game, whether or not a link is already on show. A second
     * link is a legitimate thing to add: the one on show may be for a different
     * printing, a different language, or a dead host.
     *
     * Not offered to somebody who already has one, because the API refuses that
     * (one link per game per author, idx_bgb_chapters_rulebook_author) — the
     * button would be a tap into a 409. Editing theirs is the path, and the row
     * above carries that button.
     */
    _renderAddRulebook(hasLink) {
      return `
        <button class="scroll-panel__notice scroll-panel__notice--create" type="button"
                onclick="window.referenceGuideScroll._addRulebook(event)">
          <i data-icon="plus" class="w-4 h-4"></i>
          <span class="scroll-panel__notice-text">
            ${hasLink ? "Add another rulebook link" : "Add a rulebook link"}
          </span>
        </button>
      `;
    }

    /**
     * Into the chapter wizard on its link step, against the BASE game.
     *
     * Always the base game and never an active expansion, for the reason
     * _openCreateTemplate gives about grids: the rulebook is the book for the
     * table, and the base game is the pool every player of it reads. Filing one
     * against an expansion deliberately is still possible from the Browse
     * screen's own target selector.
     */
    _addRulebook(event) {
      if (event) event.stopPropagation();
      window.router.go("reference-guide-add", {
        gameId: this._baseGameId,
        gameName: this._baseGameName(),
        expansionIds: this._gameIds.filter((id) => id !== this._baseGameId).join(","),
        mode: "create",
        layout: "rulebook_link",
      });
    }

    /**
     * Patch the rulebook hosts in place — the body's section and the peek's
     * copy — rather than re-rendering. Same hazard, and the same reason, as
     * _paintNotice: a full render destroys the search field mid-keystroke.
     */
    _paintRulebook() {
      if (!this._container) return;
      const html = this._renderRulebookSection();
      const peekHtml = this._renderRulebookPeek();
      const hosts = this._container.querySelectorAll("[data-rulebook-host]");
      if (!hosts.length) {
        // No host in the DOM: the scroll is anonymous or still loading. A full
        // render is right if there is now something to say and harmless
        // otherwise — the same fallback _paintNotice takes.
        if (html) this._render();
        return;
      }
      for (const host of hosts) {
        host.innerHTML = host.classList.contains("scroll-panel__rulebook-host--peek")
          ? peekHtml
          : html;
        window.BgbIcons.render(host);
      }
      // The section just changed height under a cap that may have been measured
      // before it existed.
      this._syncOpenHeight();
    }

    /**
     * The Scoring section — always the LAST section of the scroll.
     *
     * Two rows, in order:
     *   * the grids the viewer has adopted for this game → their real tables,
     *     collapsed like every other chapter, with the same remove/edit/report
     *     actions (suppressed wholesale by `showScoringGrids: false` on a
     *     screen that already draws the scorepad — see isScoringGrid above);
     *   * under them, the section's one call to action — adopt a grid that
     *     exists, or write the first when none does (_renderScoringCta).
     *
     * With neither, the section renders nothing: an empty "Scoring" heading is
     * not information. That is the case while the pool is still loading, and
     * the case where every grid that exists has been adopted already.
     *
     * Narrowed by the search box like every other section — read off the
     * widget rather than passed in, because _paintNotice repaints this section
     * on its own and would otherwise silently unfilter it mid-search.
     */
    _renderScoringSection() {
      const grids = this._showScoringGrids ? this._matchingGrids() : [];
      const notice = this._renderScoringCta();
      if (!grids.length && !notice) return "";
      const count = grids.length > 1 ? ` (${grids.length})` : "";
      return `
        <section class="scroll-section scroll-section--scoring" data-type="scoring_grid">
          <h4 class="scroll-section__header">
            <i data-icon="table" class="w-4 h-4"></i>
            Scoring${count}
          </h4>
          ${grids.length ? `<ul class="scroll-chapter-list">
            ${grids.map((c) => this._renderChapter(c)).join("")}
          </ul>` : ""}
          ${notice}
        </section>
      `;
    }

    /**
     * "Nobody has written one — write the first" — shown only when the pool for
     * this game is genuinely EMPTY.
     *
     * Deliberately not an alternative to the offer but a fallback behind it
     * (see the `||` in _renderScoringSection): with grids already written,
     * adopting one beats authoring a second, and two calls to action in one
     * small section is the pair .claude/rules/ui-object-design.md §3b is about.
     * It is equally not shown while the pool is still loading — an empty
     * `_templates` before the fetch lands is silence, not an answer — nor on a
     * screen that already draws the scorepad, where the guide is not the place
     * the grid is decided (see the `showScoringGrids` note on the constructor).
     */
    _renderCreateTemplate() {
      if (!this._showScoringGrids) return "";
      // "Grids exist" means grids that still exist FOR THIS VIEWER: a grid
      // they have turned down (migration 033) is one they have already
      // decided about, and leaving it to suppress this button is how somebody
      // who refused the only bad grid for a game ends up on a screen that
      // offers them nothing at all. Refusing it is exactly the moment writing
      // your own becomes the useful next step.
      //
      // NOT pendingTemplates(), which also drops the grids the viewer has
      // ADOPTED — those must keep this button away, and this is the one
      // reader that cares about the difference.
      if (!this._templatesLoaded) return "";
      if ((this._templates || []).some((t) => !t.disliked)) return "";
      return `
        <button class="scroll-panel__notice scroll-panel__notice--create" type="button"
                onclick="window.referenceGuideScroll._openCreateTemplate(event)">
          <i data-icon="plus" class="w-4 h-4"></i>
          <span class="scroll-panel__notice-text">
            No scoring template yet — tap to build one
          </span>
        </button>
      `;
    }

    /**
     * Straight into the grid builder, on its head-start step.
     *
     * Not into Browse (there is nothing to browse — that is the state this
     * button is for) and not onto the wizard's first step: step 0 asks for a
     * chapter type and this button has already said which, so it would be a tap
     * on a question already answered. Step 1 is NOT that — it offers to draft
     * the rows, which on a game nobody has written a grid for is the most
     * useful thing the wizard can do, and Skip is beside it. The builder lands
     * there with a blank row already seeded, so skipping costs nothing.
     * `mode=create&layout=scoring_grid` is read by
     * views/reference-guide-add-view.js#onMount, which also makes Cancel and
     * Save return here rather than to Browse.
     *
     * Always the BASE game, never an active expansion: a grid is the shape of
     * the whole table's scorepad, and the base game is the pool every player of
     * it reads. The Browse screen's own target selector is still where a
     * chapter is deliberately filed against an expansion.
     */
    _openCreateTemplate(event) {
      if (event) event.stopPropagation();
      const baseName = this._baseGameName();
      window.router.go("reference-guide-add", {
        gameId: this._baseGameId,
        gameName: baseName,
        expansionIds: this._gameIds.filter((id) => id !== this._baseGameId).join(","),
        mode: "create",
        layout: "scoring_grid",
      });
    }

    /**
     * The base game's name, as the merged-guide meta knows it.
     *
     * Read from `_expansionMeta` rather than held as a field of its own: the
     * meta is what the host hands in and what setGameIds replaces, so a second
     * copy would be one more thing to keep in step. Empty string when the host
     * passed no meta — every caller treats that as "don't strip / don't name",
     * which is the right answer when the base game has no name to offer.
     */
    _baseGameName() {
      return (this._expansionMeta[this._baseGameId] || {}).name || "";
    }

    /** The adopted scoring grids, narrowed by the search box when it is in use. */
    _matchingGrids() {
      const grids = (this._chapters || []).filter(isScoringGrid);
      const needle = (this._search || "").trim().toLowerCase();
      if (!needle) return grids;
      // A grid's `content` is the generated bullet mirror of its rows, so a
      // search for a row label finds it here exactly as it does in the pool.
      return grids.filter((c) =>
        (c.title || "").toLowerCase().includes(needle) ||
        (c.content || "").toLowerCase().includes(needle));
    }

    /**
     * The section's one call to action, in priority order: adopt a grid that
     * already exists, else write the first. Never both — see
     * _renderCreateTemplate. Rendered by the Scoring section, by the peek while
     * the scroll is rolled up, and by the empty state, which has no peek and no
     * section of its own; only one of those three is ever on screen at a time.
     */
    _renderScoringCta() {
      return this._renderTemplateNotice() || this._renderCreateTemplate();
    }

    _renderTemplateNotice() {
      const pending = this._pendingTemplates();
      if (!pending.length) return "";
      const n = pending.length;
      // Unfiltered: whether the viewer already keeps a grid is a fact about
      // their guide, not about what is typed in the search box.
      const mine = this._showScoringGrids && (this._chapters || []).some(isScoringGrid);
      // The wording turns on whether they already have one: "a grid exists" is
      // news to somebody with none and old news to somebody with two.
      const text = mine
        ? `${n === 1 ? "1 more custom scoring grid" : `${n} more custom scoring grids`} for this game — tap to add`
        : `${n === 1 ? "A custom scoring grid is" : `${n} custom scoring grids are`} available — tap to add`;
      return `
        <button class="scroll-panel__notice" type="button"
                onclick="window.referenceGuideScroll._openTemplates(event)">
          <i data-icon="table" class="w-4 h-4"></i>
          <span class="scroll-panel__notice-text">${text}</span>
          <span class="scroll-panel__notice-x" role="button" tabindex="0"
                aria-label="Dismiss"
                onclick="event.stopPropagation();window.referenceGuideScroll._dismissTemplates()">
            <i data-icon="x" class="w-3.5 h-3.5"></i>
          </span>
        </button>
      `;
    }

    /**
     * Tap to add → the template picker itself, not the browse screen.
     *
     * Which grid to take cannot be answered from a list of one-line rows — they
     * all carry the same derived title — so the question is put through the
     * same sheet the play cascade opens, which draws each candidate's real
     * table (widgets/scoring-template-sheet.js#offer). Same object, same
     * question, one answer surface (.claude/rules/ui-object-design.md §3b);
     * before this, the notice sent the viewer to a browse screen to make a
     * choice the sheet was already built for.
     *
     * Grids with no rows are filtered out, exactly as the play cascade filters
     * them: a candidate the sheet can only draw as an empty table is not a
     * candidate. The browse screen stays reachable from the Edit-chapters
     * button below, which is where browsing belongs, and is the fallback if the
     * sheet is somehow not on the page.
     *
     * Grouped per game, one step each, exactly as the play cascade groups them
     * — the pool this notice counts merges the base game and every expansion,
     * and the sheet asking about all of them at once is what groupByGame
     * exists to stop. No `coveredGameIds` here, though: the play cascade only
     * INTERRUPTS about games the viewer keeps nothing for, whereas somebody
     * who has TAPPED "3 grids are available" is asking to see all three.
     */
    _openTemplates(event) {
      if (event) event.stopPropagation();
      const pending = this._pendingTemplates()
        .filter((t) => t.grid && Array.isArray(t.grid.rows) && t.grid.rows.length);
      // So an expansion's grid is captioned with the expansion's name alone —
      // the scroll's own chapter rows already strip the base game off the
      // front, and the sheet opens over them.
      const baseGameName = this._baseGameName();
      const steps = pending.length && window.ScoringTemplate
        ? window.ScoringTemplate.groupByGame(pending, {
            baseGameId: this._baseGameId,
            baseGameName,
          })
        : [];
      if (!steps.length || !window.BgbScoringTemplateSheet) {
        this._openAddChapter("scoring_grid");
        return;
      }
      window.BgbScoringTemplateSheet.offer({
        steps,
        // So an expansion's grid is badged with the mode it would act in
        // (migration 032) — the guide's pool merges base + expansions, and
        // "adds two rows" and "is the whole score sheet instead" are not the
        // same offer.
        baseGameId: this._baseGameId,
        baseGameName,
        returnFocus: (event && event.currentTarget) || null,
        onAdopt: (tpl) => this._adoptTemplate(tpl),
        onSkip: (shown) => this._dismissTemplates(shown),
        onDislike: (tpl) => this._dislikeTemplate(tpl),
      });
    }

    /**
     * Turn one offered grid down for good (migration 033).
     *
     * The sheet has already dropped the card; this is the write behind it. Not
     * _dismissTemplates: that is the per-device "not now" that only quiets this
     * notice, where a dislike takes the grid out of the pool, off the guide's
     * "N of M" and out of every future offer on every device.
     *
     * refresh() rather than a local splice, and only once the write lands: the
     * scroll holds three lists the dislike changes (the pool, the pending
     * templates behind the notice, and the count on the Edit-chapters button),
     * and re-reading them in one pass is what keeps the notice, the Scoring
     * section and the button agreeing with each other.
     */
    async _dislikeTemplate(tpl) {
      const targetGameId = tpl.source_game_id || tpl.game_id || this._baseGameId;
      try {
        await window.Chapter.dislike(targetGameId, tpl.id);
        window.Chapter.invalidateChaptersCache();
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: targetGameId },
        }));
        if (typeof showToast === "function") showToast("Won't suggest that again", "info");
        await this.refresh();
      } catch (e) {
        if (typeof showToast === "function") {
          showToast((e && e.message) || "Couldn't turn that grid down", "error");
        }
        // No rollback into the sheet: it is a transient surface the viewer is
        // still standing in front of, and re-inserting a card under their thumb
        // mid-pass is worse than the grid simply being back next time. The
        // refresh above is skipped, so nothing local claims the write landed.
      }
    }

    /**
     * Take one of the offered grids into this viewer's guide.
     *
     * A chapter is adopted against the game it BELONGS to, which for an
     * expansion's grid is the expansion and not the game the scroll is open on
     * — mirrors reference-guide-add-view#_toggleInGuide and play-flow-view's
     * _adoptTemplate.
     */
    async _adoptTemplate(tpl) {
      const targetGameId = tpl.source_game_id || tpl.game_id || this._baseGameId;
      try {
        await window.Chapter.add(targetGameId, tpl.id);
        window.Chapter.invalidateChaptersCache();
        // The same event the add screen fires, so any other surface holding
        // this game's guide (Game Detail's own listener, the Play cascade)
        // reloads rather than keeping a list that is now short one chapter.
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: targetGameId },
        }));
        if (typeof showToast === "function") showToast("Added to your reference guide", "success");
        // Re-reads both lists: the grid moves out of the pending pool and into
        // the Scoring section in one pass.
        await this.refresh();
        this._onAfterMutate();
      } catch (e) {
        if (typeof showToast === "function") {
          showToast((e && e.message) || "Couldn't add that to your guide", "error");
        }
      }
    }

    /**
     * Turn down grids, by id — the ones the sheet actually SHOWED when it is
     * answering for the sheet, or everything pending when it is the notice's
     * own dismiss X. A grid the sample left out was never put to anybody, so it
     * stays pending.
     */
    _dismissTemplates(shown) {
      const ids = (shown || this._pendingTemplates()).map((t) => t.id);
      window.Chapter.dismissTemplates(this._baseGameId, ids);
      this._paintNotice();
    }

    // Hand the loaded chapter list to anyone else on the screen that needs it.
    //
    // The only listener today is play-flow-view, which wants the scoring-grid
    // chapters (migration 018) to know whether to pre-fill the scoring table.
    // It listens rather than fetching because the two mount in the SAME frame
    // for the same gameIds: calling Chapter.myChapters itself would double the
    // request on every cold mount, and this widget has already done it — with a
    // localStorage seed and a revalidation the other one would have to
    // reimplement.
    _announceChapters() {
      document.dispatchEvent(new CustomEvent("guide-chapters-loaded", {
        detail: { gameId: this._baseGameId, chapters: this._chapters },
      }));
    }

    _render() {
      if (!this._container) return;
      // Was the scroll rolled a moment ago? _html() always paints it open, so
      // the live DOM is the only record of what the user is looking at. The one
      // path that changes the roll state THROUGH a render is _onSearch's
      // auto-expand; replaying the transition on the fresh nodes is what makes
      // the first keystroke unroll the scroll rather than teleport it open.
      const prev = this._container.querySelector(".scroll-paper");
      const wasRolled = !!(prev && prev.classList.contains("scroll-paper--rolled"));
      this._container.innerHTML = this._html();
      window.BgbIcons.render(this._container);
      this._wireAccordion(this._container);
      this._applyScrollState({ animate: !!prev && wasRolled === this._scrollOpen });
    }

    /**
     * Put the open/rolled state on the LIVE DOM.
     *
     * This exists because _toggleScroll used to be `flip the flag; _render()`,
     * and _render replaces the whole panel — so the browser only ever saw the
     * FINAL state and the transition in styles.css never ran once. It also
     * destroyed the button under the user's finger (losing :active and focus)
     * and closed every expanded <details> in the scroll.
     *
     * max-height is animated from a MEASURED scrollHeight rather than the old
     * 4000px ceiling: over ~600px of content, 4000 → 0 spends ~85% of the
     * transition off-screen and then snaps.
     *
     * @param {{animate?: boolean}} [opts]
     */
    _applyScrollState({ animate = false } = {}) {
      if (!this._container) return;
      const paper = this._container.querySelector(".scroll-paper");
      const body = this._container.querySelector("#guide-scroll-body");
      // States A and B are bare sheets with no rolls — nothing to toggle.
      if (!paper || !body) return;
      const open = this._scrollOpen;

      // Both rolls are the same disclosure control, so both carry the state.
      paper.querySelectorAll(".scroll-paper__roll").forEach((btn) => {
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        btn.setAttribute("aria-label", open
          ? "Roll up the reference guide"
          : "Unroll the reference guide");
      });

      this._cancelHeightRelease(body);

      if (!animate) {
        paper.classList.toggle("scroll-paper--rolled", !open);
        // No inline cap while open: a repainted Scoring section, a repainted Add
        // button, or an expanded <details> must be free to grow.
        body.style.maxHeight = open ? "" : "0px";
        return;
      }

      // Start from where it actually stands, so a toggle mid-transition reverses
      // from that point instead of jumping to an end state.
      body.style.maxHeight = (open ? 0 : body.scrollHeight) + "px";
      void body.offsetHeight;                      // flush, so there is a start value
      paper.classList.toggle("scroll-paper--rolled", !open);
      body.style.maxHeight = (open ? body.scrollHeight : 0) + "px";
      this._releaseHeight(body);
    }

    _cancelHeightRelease(body) {
      if (this._heightTimer) { clearTimeout(this._heightTimer); this._heightTimer = null; }
      if (this._heightDone) { body.removeEventListener("transitionend", this._heightDone); this._heightDone = null; }
    }

    /**
     * Drop the inline max-height once an OPEN scroll has finished unrolling.
     *
     * Whichever arrives first wins: transitionend is the honest signal, the
     * timer is the backstop for prefers-reduced-motion (where the transition is
     * suppressed and no event fires) and for a tab backgrounded mid-animation.
     */
    _releaseHeight(body) {
      const finish = () => {
        this._cancelHeightRelease(body);
        if (this._scrollOpen) body.style.maxHeight = "";
      };
      this._heightDone = (ev) => {
        if (ev.target === body && ev.propertyName === "max-height") finish();
      };
      body.addEventListener("transitionend", this._heightDone);
      // 600ms must stay at or above the max-height transition on
      // .scroll-panel__body in styles.css (520ms), plus slack.
      this._heightTimer = setTimeout(finish, 600);
    }

    /**
     * Re-measure an open scroll whose content just changed underneath it.
     *
     * Only matters while an unroll is still in flight — after it lands the cap
     * is gone and the body is free-height. Called by the two in-place painters
     * (_paintNotice, _paintAddButton), either of which can land at an arbitrary
     * moment: the Scoring section arrives with the template fetch, the Add
     * button's "(3 of 12)" arrives with the pool count, and both change the
     * body's height against a cap measured before they existed.
     */
    _syncOpenHeight() {
      if (!this._scrollOpen || !this._heightTimer) return;
      const body = this._container && this._container.querySelector("#guide-scroll-body");
      if (body) body.style.maxHeight = body.scrollHeight + "px";
    }

    /**
     * Per-section accordion mutex: opening a chapter inside a
     * .scroll-chapter-list closes any other open <details> in the same list.
     * `toggle` doesn't bubble, so listen in capture phase.
     *
     * Takes a root because the Scoring section is repainted on its own by
     * _paintNotice, and a list that arrives that way needs the same wiring as
     * one that arrives with a full render.
     *
     * @param {Element} root
     */
    _wireAccordion(root) {
      root.querySelectorAll(".scroll-chapter-list").forEach((list) => {
        list.addEventListener("toggle", (ev) => {
          const opened = ev.target;
          if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
          list.querySelectorAll("details[open]").forEach((d) => {
            if (d !== opened) d.open = false;
          });
        }, true);
      });
    }

    _html() {
      const anon = !window.session;

      // State A: anonymous viewer.
      if (anon) {
        return `
          <div class="scroll-panel">
            <div class="scroll-panel__body">
              <!-- The rulebook is the one thing here a signed-out reader can
                   still use, so it sits above the sign-in line rather than
                   behind it. A guest watching a session from a join code is
                   exactly this viewer. -->
              <div class="scroll-panel__rulebook-host" data-rulebook-host>${this._renderRulebookSection()}</div>
              <div class="scroll-panel__empty">
                <p>Sign in to build a reference guide.</p>
                <button class="btn btn-primary btn-sm mt-2" onclick="window.router.go('auth')">
                  Sign in
                </button>
              </div>
            </div>
          </div>
        `;
      }

      const visible = this._visibleChapters();
      const hasChapters = visible.length > 0;
      // An adopted scoring grid is a chapter of the scroll even though it is
      // not in `visible` — it is drawn by its own section at the foot of the
      // body. A guide holding nothing but grids is State C, not the empty one.
      // Unfiltered, like `visible`: which state the scroll is in is a fact
      // about the guide, not about what is typed in the search box.
      const hasScoring = this._showScoringGrids
        && (this._chapters || []).some(isScoringGrid);

      // State B: signed in, nothing in the scroll at all. Always open, no search.
      if (!this._loading && !hasChapters && !hasScoring) {
        return `
          <div class="scroll-panel">
            <div class="scroll-panel__body">
              <div class="scroll-panel__empty">
                <!-- No whitespace inside any host: :empty does not match an
                     element holding a whitespace text node, and an empty host is
                     a flex item that would otherwise buy a gap with nothing in
                     it. Same reason in State C below. -->
                <!-- The rulebook leads even the empty state. A guide with
                     nothing in it is exactly where "where are the rules" is the
                     live question. -->
                <div class="scroll-panel__rulebook-host" data-rulebook-host>${this._renderRulebookSection()}</div>
                <div class="scroll-panel__notice-host" data-notice-host>${this._renderScoringCta()}</div>
                <div class="scroll-panel__add-host" data-add-host>${this._renderAddButton()}</div>
              </div>
            </div>
          </div>
        `;
      }

      // State C: signed in, has chapters (or still loading). Toggleable.
      //
      // The roll state is NOT written here. _html() always paints the paper
      // OPEN and _applyScrollState puts `--rolled` on before the browser gets a
      // frame, so the markup and the class cannot disagree — which is what lets
      // _toggleScroll flip the class on the LIVE nodes instead of re-rendering.
      // Re-rendering is why the roll transition never ran once.
      //
      // `--nosearch` IS written here: it turns only on the chapter list, so it
      // is stable across a toggle and belongs with the paint that knows it.
      const canSearch = this._canSearch(visible);
      const needle = (this._search || "").trim().toLowerCase();
      const filtered = needle
        ? visible.filter((c) =>
            (c.title || "").toLowerCase().includes(needle) ||
            (c.content || "").toLowerCase().includes(needle))
        : visible;

      // The "no match" line is about the whole scroll, so a search that matched
      // only a scoring grid must not print it above the grid it matched.
      const matchedScoring = this._showScoringGrids && this._matchingGrids().length > 0;
      const noMatch = matchedScoring
        ? ""
        : `<div class="scroll-panel__empty">No chapters match "${escapeHtml(this._search)}".</div>`;
      const bodyInner = this._loading
        ? `<div class="scroll-panel__loading">${window.gameLoader({ image: this._gameImage, size: 72, label: "Loading guide…" })}</div>`
        : (filtered.length > 0
            ? this._groupChaptersByType(filtered)
                .map((g) => this._renderChapterSection(g)).join("")
            : noMatch);

      return `
        <div class="scroll-paper${canSearch ? "" : " scroll-paper--nosearch"}">
          ${rollHtml("top")}
          <div class="scroll-panel">
            <div class="scroll-panel__peek">
              <!-- The peek is the strip that stays visible when the scroll is
                   rolled up — and rolled up is how the Play screen opens it, with
                   the Scoring section at the foot of the body hidden with the
                   rest of it. So the notice SHOWS here only while rolled: open,
                   that section says the same thing in the place the grid itself
                   would be, and two copies of one offer on one screen is the
                   duplicate .claude/rules/ui-object-design.md §3b is about. Both
                   open the same sheet. State B (nothing in the scroll) renders no
                   peek at all, so it carries its own copy of the host above.

                   Both tenants are now in the DOM in BOTH states and shown or
                   hidden by state classes on .scroll-paper, because _toggleScroll
                   flips a class on the live nodes rather than re-rendering — a
                   tenant that only exists in one state cannot animate across the
                   toggle. display:none keeps a hidden tenant out of the
                   accessibility tree and out of the peek's flex gap, so the
                   cascade enforces what the branches used to.

                   Open, with too few chapters to search, both tenants are
                   suppressed — and the strip itself goes with them rather than
                   being left as a band of padding between the roll and the body.
                   That is the --nosearch:not(--rolled) rule in styles.css. -->
              <!-- The rulebook rides in the peek for the same reason the
                   scoring offer does: rolled up is how the Play screen opens
                   this scroll, and "where are the rules" is a question asked
                   mid-game, not one worth an unroll. Shown only while rolled —
                   open, the section at the top of the body says it in the place
                   the link belongs, and two copies of one link on one screen is
                   the duplicate .claude/rules/ui-object-design.md §3b is about.
                   Both are the same anchor to the same URL. -->
              <div class="scroll-panel__rulebook-host scroll-panel__rulebook-host--peek" data-rulebook-host>${this._renderRulebookPeek()}</div>
              <div class="scroll-panel__notice-host" data-notice-host>${this._renderScoringCta()}</div>
              <div class="scroll-panel__search-row" data-search-host>
                <i data-icon="search" class="w-4 h-4 scroll-panel__search-icon"></i>
                <input class="scroll-panel__search"
                       id="guide-scroll-search"
                       type="text"
                       placeholder="Search chapters…"
                       aria-label="Search chapters"
                       autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                       value="${escapeAttr(this._search)}"
                       oninput="window.referenceGuideScroll._onSearch(this.value)" />
                ${window.BgbSearchField.clearButton({ value: this._search })}
              </div>
            </div>
            <div class="scroll-panel__body" id="guide-scroll-body">
              <!-- First, always: the rulebook is the document every other
                   chapter is a shortcut around (migration 052). The score sheet
                   is the mirror of this and sits last. -->
              <div class="scroll-panel__rulebook-host" data-rulebook-host>${this._renderRulebookSection()}</div>
              ${bodyInner}
              <!-- Last, always: a scoring grid is the shape of the scorepad
                   rather than a rule anybody opened the scroll to look up, and
                   migration 021's display_order would otherwise put it first.
                   No whitespace inside either host below: :empty does not match
                   an element holding a whitespace text node, and an empty host
                   is a flex item that would buy a 16px gap. -->
              <div class="scroll-panel__scoring-host" data-scoring-host>${this._renderScoringSection()}</div>
              <div class="scroll-panel__add-host" data-add-host>${this._renderAddButton()}</div>
            </div>
          </div>
          ${rollHtml("bottom")}
        </div>
      `;
    }

    _groupChaptersByType(list) {
      const groups = new Map();
      for (const c of list) {
        const key = c.chapter_type;
        if (!groups.has(key)) {
          groups.set(key, {
            type: key,
            label: c.chapter_type_label || key,
            icon: c.chapter_type_icon || "book",
            order: c.chapter_type_order || 0,
            chapters: [],
          });
        }
        groups.get(key).chapters.push(c);
      }
      return [...groups.values()].sort((a, b) => a.order - b.order);
    }

    _renderChapterSection(group) {
      return `
        <section class="scroll-section" data-type="${escapeAttr(group.type)}">
          <h4 class="scroll-section__header">
            <i data-icon="${group.icon}" class="w-4 h-4"></i>
            ${escapeHtml(group.label)}
          </h4>
          <ul class="scroll-chapter-list">
            ${group.chapters.map((c) => this._renderChapter(c)).join("")}
          </ul>
        </section>
      `;
    }

    _renderChapter(c) {
      // Source dot ties expansion chapters to their identity color. The base
      // game leaves source_color null — but with the redundant per-chapter icon
      // gone (the section header above already carries the type's glyph, and
      // every chapter in a section repeated it) there is no icon column
      // absorbing that, so an undotted row would start 17px left of a dotted one
      // and every title in a merged list would sit at a different place. The
      // column is therefore RESERVED whenever the scroll is merged, and omitted
      // entirely on a single game, where no row has a dot and the column would
      // be 17px of nothing on every row.
      const merged = this._gameIds.length > 1;
      const dot = c.source_color
        ? `<span class="scroll-chapter__source-dot" style="--exp-color:${escapeAttr(c.source_color)}"
                 title="${escapeAttr(c.source_game_name || "")}"></span>`
        : (merged ? `<span class="scroll-chapter__source-dot scroll-chapter__source-dot--none"></span>` : "");
      // Edit affordance appears only for chapters the current user authored.
      // Routes through the shared add-view in "edit" mode with the chapter
      // stashed on the singleton so we don't need an extra GET.
      const me = window.store && window.store.get("user");
      const isOwner = !!(me && c.created_by && me.id === c.created_by);
      const editBtn = isOwner ? `
        <button class="btn btn-ghost btn-xs"
                onclick="window.referenceGuideScroll._editChapter('${c.id}', event)">
          <i data-icon="pencil" class="w-3.5 h-3.5"></i> Edit
        </button>
      ` : "";
      // Every scoring grid for one game carries the SAME derived title (the
      // game's name plus "scoring" — services/chapter_grid.grid_title), so with
      // two of them adopted the title alone names neither. Who wrote it is the
      // tiebreaker, and it is the same label the offer sheet puts on the same
      // grids (widgets/scoring-template-editor.js#authorLabel).
      const by = isScoringGrid(c) && window.ScoringTemplateEditor
        ? `<span class="scroll-chapter__by">${escapeHtml(window.ScoringTemplateEditor.authorLabel(c))}</span>`
        : "";
      // An expansion grid is titled from its game's raw BGG name, base game and
      // all — "Everdell: Pearlbrook score sheet" in a scroll already headed
      // Everdell, one row under Everdell's own sheet. The base game comes off
      // here exactly as it does on the pills the play screen draws from the
      // same grids (domain/scoring-template.js#titleOf).
      const title = window.ScoringTemplate
        ? window.ScoringTemplate.titleOf(c, this._baseGameName())
        : c.title;
      return `
        <li class="scroll-chapter" data-chapter-id="${c.id}">
          <details>
            <summary class="scroll-chapter__summary">
              ${dot}
              <span class="scroll-chapter__title">${escapeHtml(title)}</span>
              ${by}
            </summary>
            <div class="scroll-chapter__content">${chapterBodyHtml(c, this._baseGameId)}</div>
            <div class="scroll-chapter__actions">
              <button class="btn btn-ghost btn-xs"
                      onclick="window.referenceGuideScroll._removeChapter('${c.id}', '${c.source_game_id || c.game_id}', event)">
                <i data-icon="book-minus" class="w-3.5 h-3.5"></i> Remove
              </button>
              ${editBtn}
              <button class="btn btn-ghost btn-xs"
                      onclick="window.referenceGuideScroll._reportChapter('${c.id}', event)">
                <i data-icon="flag" class="w-3.5 h-3.5"></i> Report
              </button>
            </div>
          </details>
        </li>
      `;
    }

    _editChapter(chapterId, event) {
      if (event) event.preventDefault();
      // The rulebook pool is searched too (migration 052): a link the author
      // has removed from their own guide is still theirs to edit, and the
      // Rulebook section draws it from `_rulebooks` rather than from the guide.
      const chapter = this._chapters.find((c) => c.id === chapterId)
        || (this._rulebooks || []).find((c) => c.id === chapterId);
      if (!chapter) return;
      // Stash the chapter on the add-view singleton — onMount picks it up
      // when mode === "edit" and prefills the editor with the chapter's
      // home-game id (source_game_id) preserved for the PATCH target.
      if (window.referenceGuideAddView) {
        window.referenceGuideAddView._prefillChapter = chapter;
      }
      const baseName = this._baseGameName();
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      window.router.go("reference-guide-add", {
        gameId: this._baseGameId,
        gameName: baseName,
        expansionIds: expansionIds.join(","),
        mode: "edit",
      });
    }

    _toggleScroll() {
      this._scrollOpen = !this._scrollOpen;
      // No _render(). See _applyScrollState — re-rendering is what killed the
      // transition, the focus ring and every open <details>. Nothing else needs
      // recomputing either: `--nosearch` and the loading state both turn on the
      // chapter list, which a toggle cannot change.
      this._applyScrollState({ animate: true });
    }

    _onSearch(v) {
      this._search = v || "";
      // Auto-expand the scroll the moment the user types. Don't auto-collapse
      // when they clear the box — once open, stay open until the user rolls it.
      if (this._search && !this._scrollOpen) this._scrollOpen = true;
      // _render() notices that the auto-expand changed the roll state and
      // replays the unroll on the new nodes, so typing opens the scroll with the
      // same motion a tap on a roll gives.
      this._render();
      const el = this._container && this._container.querySelector(".scroll-panel__search");
      if (el) { el.focus(); el.setSelectionRange(this._search.length, this._search.length); }
    }

    /**
     * The one route to the add screen. Both affordances go through it — the
     * scroll's own Edit-chapters button (_renderAddButton) and the templates
     * notice — so the two cannot land anywhere different
     * (.claude/rules/ui-object-design.md §3b).
     * @param {string} [filter] pre-set the browse tab's chapter-type filter.
     */
    _openAddChapter(filter) {
      const baseName = this._baseGameName();
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      const params = {
        gameId: this._baseGameId,
        gameName: baseName,
        expansionIds: expansionIds.join(","),
      };
      if (filter) params.filter = filter;
      window.router.go("reference-guide-add", params);
    }

    async _removeChapter(chapterId, sourceGameId, event) {
      if (event) event.preventDefault();
      try {
        await window.Chapter.remove(sourceGameId, chapterId);
        this._chapters = this._chapters.filter((c) => c.id !== chapterId);
        window.Chapter.invalidateChaptersCache();
        if (typeof showToast === "function") showToast("Removed from your guide", "info");
        this._render();
        this._onAfterMutate();
      } catch (e) {
        if (typeof showToast === "function") showToast(e.message || "Failed to remove chapter", "error");
      }
    }

    async _reportChapter(chapterId, event) {
      if (event) event.preventDefault();
      const reason = await window.PolaroidPopup.prompt({
        title: "Report this chapter",
        body: "Why are you reporting it? (optional)",
        confirmLabel: "Report",
      });
      if (reason === null) return;
      try {
        await window.Chapter.report(chapterId, reason.trim() || null);
        if (typeof showToast === "function") showToast("Reported — thanks for flagging", "success");
      } catch (e) {
        if (typeof showToast === "function") showToast(e.message || "Failed to report chapter", "error");
      }
    }
  }

  window.ReferenceGuideScroll = ReferenceGuideScroll;
})();
