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

  // A scoring grid is NOT a chapter of the guide, even though it is stored as
  // one. It is the shape of the scorepad: the host turns it on from the scoring
  // card's own bar (views/play-flow-view.js#_renderTemplateBar) and reads it
  // there, in the table they are filling in — nobody opens a reference guide to
  // look at their own score sheet's row labels. Rendered as a section it was a
  // heading and a table duplicating the grid two cards up the same screen, and
  // by migration 021's display_order it was the FIRST one, pushing the rules
  // somebody did open the scroll for below it.
  //
  // So the rows still load (the play screen is fed from the same fetch, via
  // `guide-chapters-loaded`) and are still adopted, edited, reported and
  // dropped from the browse pool in reference-guide-add-view — they are simply
  // not drawn here. Everything below reads _visibleChapters(), never
  // _chapters, and the notice above is what still names a grid in this widget.
  function isScoringGrid(c) {
    return c.layout === "scoring_grid" || c.chapter_type === "scoring_grid";
  }

  // The body of an expanded chapter. Markdown and nothing else: the one layout
  // that isn't markdown is the scoring grid, and this widget no longer draws
  // one. (reference-guide-add-view keeps its own grid-aware version — the pool
  // it browses is where a grid is still read and edited.)
  function chapterBodyHtml(c) {
    return window.renderMarkdown(c.content || "");
  }

  class ReferenceGuideScroll {
    constructor({ gameIds, baseGameId, expansionMeta, onAfterMutate, defaultOpen = true, gameImage = null } = {}) {
      this._baseGameId = baseGameId || (gameIds && gameIds[0]) || null;
      this._gameIds = (gameIds && gameIds.length) ? gameIds.slice() : (this._baseGameId ? [this._baseGameId] : []);
      this._expansionMeta = expansionMeta || {};
      this._onAfterMutate = onAfterMutate || (() => {});
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

    async _fetch() {
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
      const cached = window.Chapter && window.Chapter.cachedMyChapters
        ? window.Chapter.cachedMyChapters(this._baseGameId, expansionIds)
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
      // Offline there is nothing to revalidate against. The seed above already
      // read through the stale window, so skipping the request keeps the guide
      // exactly as it is instead of flashing the loader and landing back on
      // the same list one failed round trip later.
      if (window.BgbNet && window.BgbNet.isOffline()) {
        this._loading = false;
        this._announceChapters();
        this._render();
        // Seeds the notice from the cache and bails before the request, same
        // as this branch does.
        this._fetchTemplates();
        return;
      }
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
        ? window.Chapter.cachedScoringTemplates(this._baseGameId, expansionIds)
        : null;
      if (cached) {
        this._templates = cached;
        this._paintNotice();
        this._announceTemplates();
      }
      // Same bail as _fetch: offline there is nothing to revalidate against,
      // and a failed round trip only costs a paint.
      if (window.BgbNet && window.BgbNet.isOffline()) return;
      try {
        const rows = await window.Chapter.scoringTemplates(
          this._baseGameId, { expansionIds }
        ) || [];
        this._templates = rows;
        if (window.Chapter.cacheScoringTemplates) {
          window.Chapter.cacheScoringTemplates(this._baseGameId, expansionIds, rows);
        }
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
     * would have to reimplement the cache seed, the offline bail and the
     * revalidation this method already rides.
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
     * The chapters this widget draws — everything the guide holds except the
     * scoring grids, which belong to the scorepad rather than to the scroll
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
     * Patch the notice in place rather than re-rendering.
     *
     * _render() replaces the whole panel, which would destroy the search field
     * mid-keystroke along with its focus and caret — _onSearch only gets away
     * with that because it deliberately restores both afterwards.
     */
    _paintNotice() {
      if (!this._container) return;
      const host = this._container.querySelector("[data-notice-host]");
      const html = this._renderTemplateNotice();
      if (!host) {
        // No host in the DOM: the scroll was in a state that renders none
        // (anonymous), or the notice had nothing to say when this paint ran and
        // now does. A full render is right in the second case and harmless in
        // the first — and neither can be mid-keystroke, because the search
        // field only exists in a state that already has a host.
        if (html) this._render();
        return;
      }
      host.innerHTML = html;
      window.BgbIcons.render(host);
    }

    _renderTemplateNotice() {
      const pending = this._pendingTemplates();
      if (!pending.length) return "";
      const n = pending.length;
      return `
        <button class="scroll-panel__notice" type="button"
                onclick="window.referenceGuideScroll._openTemplates(event)">
          <i data-icon="table" class="w-4 h-4"></i>
          <span class="scroll-panel__notice-text">
            ${n === 1 ? "A custom scoring grid is" : `${n} custom scoring grids are`}
            available — tap to add
          </span>
          <span class="scroll-panel__notice-x" role="button" tabindex="0"
                aria-label="Dismiss"
                onclick="event.stopPropagation();window.referenceGuideScroll._dismissTemplates()">
            <i data-icon="x" class="w-3.5 h-3.5"></i>
          </span>
        </button>
      `;
    }

    _openTemplates(event) {
      if (event) event.stopPropagation();
      this._openAddChapter("scoring_grid");
    }

    /** Hide the notice for the templates that exist RIGHT NOW, by id. */
    _dismissTemplates() {
      window.Chapter.dismissTemplates(
        this._baseGameId, this._pendingTemplates().map((t) => t.id)
      );
      this._paintNotice();
    }

    // Hand the loaded chapter list to anyone else on the screen that needs it.
    //
    // The only listener today is play-flow-view, which wants the scoring-grid
    // chapters (migration 018) to know whether to pre-fill the scoring table.
    // It listens rather than fetching because the two mount in the SAME frame
    // for the same gameIds: calling Chapter.myChapters itself would double the
    // request on every cold mount, and this widget has already done it — with a
    // localStorage seed, an offline bail and a revalidation the other one would
    // have to reimplement.
    _announceChapters() {
      document.dispatchEvent(new CustomEvent("guide-chapters-loaded", {
        detail: { gameId: this._baseGameId, chapters: this._chapters },
      }));
    }

    _render() {
      if (!this._container) return;
      this._container.innerHTML = this._html();
      window.BgbIcons.render(this._container);
      // Per-section accordion mutex: opening a chapter inside a
      // .scroll-chapter-list closes any other open <details> in the same list.
      // `toggle` doesn't bubble, so listen in capture phase.
      this._container.querySelectorAll(".scroll-chapter-list").forEach((list) => {
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

      // State B: signed in, zero chapters. Always open, no search.
      if (!this._loading && !hasChapters) {
        return `
          <div class="scroll-panel">
            <div class="scroll-panel__body">
              <div class="scroll-panel__empty">
                <p>Add chapters for quick rule lookup and clarification.</p>
                <div class="scroll-panel__notice-host" data-notice-host>
                  ${this._renderTemplateNotice()}
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

      const bodyInner = this._loading
        ? `<div class="scroll-panel__loading">${window.gameLoader({ image: this._gameImage, size: 72, label: "Loading guide…" })}</div>`
        : (filtered.length > 0
            ? this._groupChaptersByType(filtered)
                .map((g) => this._renderChapterSection(g)).join("")
            : `<div class="scroll-panel__empty">No chapters match "${escapeHtml(this._search)}".</div>`);

      const rollupHint = open && hasChapters ? `
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
            <!-- First in the peek, which is the strip that stays visible when
                 the scroll is rolled up — and rolled up is how the Play screen
                 opens it. State B (signed in, zero chapters) renders no peek at
                 all, so it carries its own copy of the same host above. -->
            <div class="scroll-panel__notice-host" data-notice-host>
              ${this._renderTemplateNotice()}
            </div>
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
      return `
        <li class="scroll-chapter" data-chapter-id="${c.id}">
          <details>
            <summary class="scroll-chapter__summary">
              ${dot}
              <span class="scroll-chapter__icon"><i data-icon="${icon}" class="w-4 h-4"></i></span>
              <span class="scroll-chapter__title">${escapeHtml(c.title)}</span>
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
