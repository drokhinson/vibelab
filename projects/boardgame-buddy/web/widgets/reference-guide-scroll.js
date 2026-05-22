// widgets/reference-guide-scroll.js — shared parchment-scroll widget.
//
// Used by both Game Detail (single game) and Log Play (base game + active
// expansions). Owns its own state and renders into a host container element.
// When `gameIds` has more than one entry, the merged my-chapters fetch tags
// each row with source_color so the colored dot can tie it back to its
// expansion.

(function () {
  const ESCAPE_MAP = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
  }
  function escapeAttr(s) { return escape(s); }

  class ReferenceGuideScroll {
    constructor({ gameIds, baseGameId, expansionMeta, onAfterMutate, defaultOpen = false } = {}) {
      this._baseGameId = baseGameId || (gameIds && gameIds[0]) || null;
      this._gameIds = (gameIds && gameIds.length) ? gameIds.slice() : (this._baseGameId ? [this._baseGameId] : []);
      this._expansionMeta = expansionMeta || {};
      this._onAfterMutate = onAfterMutate || (() => {});

      this._container = null;
      this._scrollOpen = !!defaultOpen;
      this._chapters = [];
      this._loading = false;
      this._search = "";
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

    refresh() { return this._fetch(); }

    async _fetch() {
      if (!this._baseGameId) return;
      this._fetchedOnce = true;
      if (!window.session) {
        this._chapters = [];
        this._render();
        return;
      }
      this._loading = true;
      this._render();
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      try {
        this._chapters = await window.Chapter.myChapters(this._baseGameId, { expansionIds }) || [];
      } catch (_) {
        this._chapters = [];
      } finally {
        this._loading = false;
        this._render();
      }
    }

    _render() {
      if (!this._container) return;
      this._container.innerHTML = this._html();
      if (window.lucide) window.lucide.createIcons();
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

      const hasChapters = this._chapters.length > 0;

      // State B: signed in, zero chapters. Always open, no search.
      if (!this._loading && !hasChapters) {
        return `
          <div class="scroll-panel">
            <div class="scroll-panel__body">
              <div class="scroll-panel__empty">
                <p>Add chapters for quick rule lookup and clarification.</p>
                <button class="scroll-panel__add"
                        onclick="window.referenceGuideScroll._openAddChapter()">
                  <i data-lucide="plus" class="w-4 h-4"></i> Add a chapter
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
        ? this._chapters.filter((c) =>
            (c.title || "").toLowerCase().includes(needle) ||
            (c.content || "").toLowerCase().includes(needle))
        : this._chapters;

      const bodyInner = this._loading
        ? `<div class="scroll-panel__loading">${window.buddyLoader({ size: 60 })}</div>`
        : (filtered.length > 0
            ? this._groupChaptersByType(filtered)
                .map((g) => this._renderChapterSection(g)).join("")
            : `<div class="scroll-panel__empty">No chapters match "${escape(this._search)}".</div>`);

      const rollupHint = open && hasChapters ? `
        <button class="scroll-panel__rollup-hint" type="button"
                onclick="window.referenceGuideScroll._toggleScroll()">
          <i data-lucide="chevron-up" class="w-3.5 h-3.5"></i>
          Tap to roll up scroll
        </button>
      ` : "";

      return `
        <div class="scroll-panel ${rolledClass}">
          <button class="scroll-panel__roll scroll-panel__roll--top"
                  aria-label="${open ? "Roll up the reference guide" : "Open the reference guide"}"
                  onclick="window.referenceGuideScroll._toggleScroll()"></button>
          <div class="scroll-panel__peek">
            <div class="scroll-panel__search-row">
              <i data-lucide="search" class="w-4 h-4 scroll-panel__search-icon"></i>
              <input class="scroll-panel__search"
                     type="search"
                     placeholder="Search chapters…"
                     value="${escapeAttr(this._search)}"
                     oninput="window.referenceGuideScroll._onSearch(this.value)" />
            </div>
            ${!open ? `
              <button class="scroll-panel__hint" type="button"
                      onclick="window.referenceGuideScroll._toggleScroll()">
                <i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>
                Tap to expand and see chapters
              </button>` : ""}
          </div>
          <div class="scroll-panel__body">
            ${bodyInner}
            <button class="scroll-panel__add"
                    onclick="window.referenceGuideScroll._openAddChapter()">
              <i data-lucide="plus" class="w-4 h-4"></i> Add a chapter
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
            <i data-lucide="${group.icon}" class="w-4 h-4"></i>
            ${escape(group.label)}
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
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i> Edit
        </button>
      ` : "";
      return `
        <li class="scroll-chapter" data-chapter-id="${c.id}">
          <details>
            <summary class="scroll-chapter__summary">
              ${dot}
              <span class="scroll-chapter__icon"><i data-lucide="${icon}" class="w-4 h-4"></i></span>
              <span class="scroll-chapter__title">${escape(c.title)}</span>
            </summary>
            <div class="scroll-chapter__content">${window.renderMarkdown(c.content || "")}</div>
            <div class="scroll-chapter__actions">
              <button class="btn btn-ghost btn-xs"
                      onclick="window.referenceGuideScroll._removeChapter('${c.id}', '${c.source_game_id || c.game_id}', event)">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove from my guide
              </button>
              ${editBtn}
              <button class="btn btn-ghost btn-xs"
                      onclick="window.referenceGuideScroll._reportChapter('${c.id}', event)">
                <i data-lucide="flag" class="w-3.5 h-3.5"></i> Report
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

    _openAddChapter() {
      const baseName = (this._expansionMeta[this._baseGameId] || {}).name || "";
      const expansionIds = this._gameIds.filter((id) => id !== this._baseGameId);
      window.router.go("reference-guide-add", {
        gameId: this._baseGameId,
        gameName: baseName,
        expansionIds: expansionIds.join(","),
      });
    }

    async _removeChapter(chapterId, sourceGameId, event) {
      if (event) event.preventDefault();
      try {
        await window.Chapter.remove(sourceGameId, chapterId);
        this._chapters = this._chapters.filter((c) => c.id !== chapterId);
        if (typeof showToast === "function") showToast("Removed from your guide", "info");
        this._render();
        this._onAfterMutate();
      } catch (e) {
        if (typeof showToast === "function") showToast(e.message || "Failed to remove chapter", "error");
      }
    }

    async _reportChapter(chapterId, event) {
      if (event) event.preventDefault();
      const reason = window.prompt(
        "Why are you reporting this chapter? (optional)",
        ""
      );
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
