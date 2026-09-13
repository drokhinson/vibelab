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
  function chapterBodyHtml(c) {
    const rows = gridRows(c);
    if (rows && window.ScoringTemplateEditor) {
      return window.ScoringTemplateEditor.preview(rows, `guideGrid-${c.id}`);
    }
    return window.renderMarkdown(c.content || "");
  }

  class ReferenceGuideScroll {
    /**
     * @param {Object} opts
     * @param {boolean} [opts.showScoringGrids=true] draw the adopted scoring
     *   grids in the Scoring section. Pass false on a screen that already
     *   renders the live scorepad (the Play cascade, the session viewer) —
     *   there the same table two cards apart is a duplicate, not a reference.
     *   The "a grid exists for this game" offer is unaffected either way.
     */
    constructor({ gameIds, baseGameId, expansionMeta, onAfterMutate, defaultOpen = true, gameImage = null,
                  showScoringGrids = true } = {}) {
      this._baseGameId = baseGameId || (gameIds && gameIds[0]) || null;
      this._gameIds = (gameIds && gameIds.length) ? gameIds.slice() : (this._baseGameId ? [this._baseGameId] : []);
      this._expansionMeta = expansionMeta || {};
      this._onAfterMutate = onAfterMutate || (() => {});
      this._showScoringGrids = showScoringGrids !== false;
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
      }
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
      return (this._chapters || []).filter((c) => !isScoringGrid(c));
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
      if (!this._templatesLoaded || this._templates.length) return "";
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
     * Straight into the grid builder, on the row editor.
     *
     * Not into Browse (there is nothing to browse — that is the state this
     * button is for) and not onto the wizard's first step: step 0 asks for a
     * chapter type and this button has already said which, step 1 is the AI
     * head start a grid skips in both directions, so both would be a tap on a
     * question already answered. `mode=create&layout=scoring_grid` is read by
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
      const baseName = (this._expansionMeta[this._baseGameId] || {}).name || "";
      window.router.go("reference-guide-add", {
        gameId: this._baseGameId,
        gameName: baseName,
        expansionIds: this._gameIds.filter((id) => id !== this._baseGameId).join(","),
        mode: "create",
        layout: "scoring_grid",
      });
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
     * candidate. The browse screen stays reachable from "Add a chapter" below,
     * which is where browsing belongs, and is the fallback if the sheet is
     * somehow not on the page.
     */
    _openTemplates(event) {
      if (event) event.stopPropagation();
      const pending = this._pendingTemplates()
        .filter((t) => t.grid && Array.isArray(t.grid.rows) && t.grid.rows.length);
      if (!pending.length || !window.BgbScoringTemplateSheet) {
        this._openAddChapter("scoring_grid");
        return;
      }
      window.BgbScoringTemplateSheet.offer({
        templates: pending,
        returnFocus: (event && event.currentTarget) || null,
        onAdopt: (tpl) => this._adoptTemplate(tpl),
        onSkip: (shown) => this._dismissTemplates(shown),
      });
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
      this._container.innerHTML = this._html();
      window.BgbIcons.render(this._container);
      this._wireAccordion(this._container);
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
                <p>Add chapters for quick rule lookup and clarification.</p>
                <div class="scroll-panel__notice-host" data-notice-host>
                  ${this._renderScoringCta()}
                </div>
                <button class="scroll-panel__add"
                        onclick="window.referenceGuideScroll._openAddChapter()">
                  <i data-icon="plus" class="w-4 h-4"></i> Add a chapter
                </button>
              </div>
            </div>
          </div>
        `;
      }

      // State C: signed in, has chapters (or still loading). Toggleable.
      const open = this._scrollOpen;
      const rolledClass = open ? "" : "scroll-panel--rolled";
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

      const rollupHint = open && (hasChapters || hasScoring) ? `
        <button class="scroll-panel__rollup-hint" type="button"
                onclick="window.referenceGuideScroll._toggleScroll()">
          <i data-icon="chevron-up" class="w-3.5 h-3.5"></i>
          Tap to roll up scroll
        </button>
      ` : "";

      return `
        <div class="scroll-panel ${rolledClass}">
          <button class="scroll-panel__roll scroll-panel__roll--top"
                  aria-label="${open ? "Roll up the reference guide" : "Open the reference guide"}"
                  onclick="window.referenceGuideScroll._toggleScroll()"></button>
          <div class="scroll-panel__peek">
            <!-- The peek is the strip that stays visible when the scroll is
                 rolled up — and rolled up is how the Play screen opens it, with
                 the Scoring section at the foot of the body hidden with the
                 rest of it. So the notice rides here ONLY while rolled: open,
                 that section says the same thing in the place the grid itself
                 would be, and two copies of one offer on one screen is the
                 duplicate .claude/rules/ui-object-design.md §3b is about. Both
                 open the same sheet. State B (nothing in the scroll) renders no
                 peek at all, so it carries its own copy of the host above. -->
            ${!open ? `<div class="scroll-panel__notice-host" data-notice-host>
              ${this._renderScoringCta()}
            </div>` : ""}
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
            ${!open ? `
              <button class="scroll-panel__hint" type="button"
                      onclick="window.referenceGuideScroll._toggleScroll()">
                <i data-icon="chevron-down" class="w-3.5 h-3.5"></i>
                Tap to expand and see chapters
              </button>` : ""}
          </div>
          <div class="scroll-panel__body">
            ${bodyInner}
            <!-- Last, always: a scoring grid is the shape of the scorepad
                 rather than a rule anybody opened the scroll to look up, and
                 migration 021's display_order would otherwise put it first. -->
            <div class="scroll-panel__scoring-host" data-scoring-host>
              ${this._renderScoringSection()}
            </div>
            <button class="scroll-panel__add"
                    onclick="window.referenceGuideScroll._openAddChapter()">
              <i data-icon="plus" class="w-4 h-4"></i> Add a chapter
            </button>
            ${rollupHint}
          </div>
          <button class="scroll-panel__roll scroll-panel__roll--bottom"
                  aria-label="${open ? "Roll up the reference guide" : "Open the reference guide"}"
                  onclick="window.referenceGuideScroll._toggleScroll()"></button>
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
      const icon = c.chapter_type_icon || "book";
      // Source dot ties expansion chapters to their identity color.
      // The base game leaves source_color null, so no dot rendered.
      const dot = c.source_color
        ? `<span class="scroll-chapter__source-dot" style="--exp-color:${escapeAttr(c.source_color)}"
                 title="${escapeAttr(c.source_game_name || "")}"></span>`
        : "";
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
      return `
        <li class="scroll-chapter" data-chapter-id="${c.id}">
          <details>
            <summary class="scroll-chapter__summary">
              ${dot}
              <span class="scroll-chapter__icon"><i data-icon="${icon}" class="w-4 h-4"></i></span>
              <span class="scroll-chapter__title">${escapeHtml(c.title)}</span>
              ${by}
            </summary>
            <div class="scroll-chapter__content">${chapterBodyHtml(c)}</div>
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
      const chapter = this._chapters.find((c) => c.id === chapterId);
      if (!chapter) return;
      // Stash the chapter on the add-view singleton — onMount picks it up
      // when mode === "edit" and prefills the editor with the chapter's
      // home-game id (source_game_id) preserved for the PATCH target.
      if (window.referenceGuideAddView) {
        window.referenceGuideAddView._prefillChapter = chapter;
      }
      const baseName = (this._expansionMeta[this._baseGameId] || {}).name || "";
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
      this._render();
    }

    _onSearch(v) {
      this._search = v || "";
      // Auto-expand the scroll the moment the user types. Don't auto-collapse
      // when they clear the box — once open, stay open until the user rolls it.
      if (this._search && !this._scrollOpen) this._scrollOpen = true;
      this._render();
      const el = this._container && this._container.querySelector(".scroll-panel__search");
      if (el) { el.focus(); el.setSelectionRange(this._search.length, this._search.length); }
    }

    /**
     * The one route to the add screen. Both affordances go through it — the
     * scroll's own "Add a chapter" and the templates notice — so the two cannot
     * land anywhere different (.claude/rules/ui-object-design.md §3b).
     * @param {string} [filter] pre-set the browse tab's chapter-type filter.
     */
    _openAddChapter(filter) {
      const baseName = (this._expansionMeta[this._baseGameId] || {}).name || "";
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
