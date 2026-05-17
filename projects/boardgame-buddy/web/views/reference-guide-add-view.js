// views/reference-guide-add-view.js — add a chapter to the user's
// reference guide for a game. Two tabs: Create (author new) or Browse
// (pick from the community pool, sorted by popularity).

(function () {
  class ReferenceGuideAddView extends window.View {
    constructor() {
      super("reference-guide-add");
      this._tab = "browse";          // "browse" | "create"
      this._gameId = null;            // base game uuid (route param)
      this._gameName = "";
      // Optional expansion uuids passed from the in-play guide widget. When
      // present, Browse shows chapters across base + these expansions and the
      // Create tab gets a "Target game" picker so the new chapter can be
      // saved against an expansion's pool.
      this._expansionIds = [];
      this._expansionMeta = {};       // gameId → {name, color}
      this._createTargetGameId = null; // defaults to base game in onMount

      // Browse state
      this._poolLoading = false;
      this._pool = [];
      this._search = "";
      this._typeFilter = "";

      // Create state
      this._types = [];
      this._formType = "";
      this._formTitle = "";
      this._formContent = "";
      this._createSubTab = "write"; // "write" | "preview"
      this._saving = false;
      this._error = null;

      // Preview modal: id of the chapter whose full markdown content is
      // currently shown; null = no modal.
      this._previewChapterId = null;
    }

    async onMount() {
      this._gameId = (this.params && this.params.gameId) || null;
      this._gameName = (this.params && this.params.gameName) || "";
      this._tab = (this.params && this.params.tab) || "browse";
      const rawExp = (this.params && this.params.expansionIds) || "";
      this._expansionIds = rawExp.split(",").map((s) => s.trim()).filter(Boolean);
      this._createTargetGameId = this._gameId;
      this._expansionMeta = this._gameId
        ? { [this._gameId]: { name: this._gameName, color: null } }
        : {};
      // Escape dismisses the preview modal. Auto-removed on view unmount.
      this.listenDom("keydown", (e) => {
        if (e.key === "Escape" && this._previewChapterId) this._closePreview();
      });
      if (!this._gameId) {
        this.render();
        return;
      }
      // Always preload chapter types — they're needed by both tabs. When
      // expansions are in scope, also fetch the base game's expansion list
      // so we can populate names/colors for the Create-target selector.
      const typesP = window.Chapter.types().catch(() => []);
      const expsP = this._expansionIds.length
        ? window.api.get(`/games/${this._gameId}/expansions`).catch(() => [])
        : Promise.resolve([]);
      const [types, exps] = await Promise.all([typesP, expsP]);
      this._types = types || [];
      for (const e of (exps || [])) {
        if (this._expansionIds.includes(e.expansion_game_id)) {
          this._expansionMeta[e.expansion_game_id] = { name: e.name, color: e.color || null };
        }
      }
      if (this._tab === "browse") await this._loadPool();
      this.render();
    }

    async onParamsChange() { await this.onMount(); }

    async _loadPool() {
      if (!this._gameId) return;
      this._poolLoading = true;
      this.render();
      try {
        const pool = await window.Chapter.pool(this._gameId, {
          q: this._search || undefined,
          chapterType: this._typeFilter || undefined,
          expansionIds: this._expansionIds.length ? this._expansionIds : undefined,
        });
        // Show every pool row regardless of in_my_guide — the per-row
        // toggle button reflects the current state and adds/removes
        // without hiding the row.
        this._pool = pool || [];
      } catch (e) {
        showToast(e.message || "Failed to load chapter pool", "error");
        this._pool = [];
      } finally {
        this._poolLoading = false;
        this.render();
      }
    }

    // Mirrors GameDetailView._groupChaptersByType so the user's guide and
    // the Browse pool read with the same per-type section headers.
    _groupPoolByType(list) {
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

    render() {
      if (!this._gameId) {
        this.container.innerHTML = `
          <div class="p-6 text-center">
            <p class="opacity-60 mb-3">No game specified.</p>
            <button class="btn btn-primary" onclick="window.router.back('feed')">Back</button>
          </div>
        `;
        return;
      }
      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('game-detail')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-lg">Add a chapter</h2>
          <span></span>
        </header>
        <p class="text-xs opacity-60 px-1 mb-2">
          ${escape(this._gameName) || "Reference guide"}
        </p>
        <div class="chapter-add__tabs" role="tablist">
          <button class="chapter-add__tab ${this._tab === "browse" ? "chapter-add__tab--active" : ""}"
                  onclick="window.referenceGuideAddView._setTab('browse')">
            <i data-lucide="library" class="w-4 h-4"></i> Browse
          </button>
          <button class="chapter-add__tab ${this._tab === "create" ? "chapter-add__tab--active" : ""}"
                  onclick="window.referenceGuideAddView._setTab('create')">
            <i data-lucide="plus" class="w-4 h-4"></i> Create new
          </button>
        </div>
        ${this._tab === "browse" ? this._renderBrowse() : this._renderCreate()}
        ${this._renderPreviewModal()}
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    async _setTab(t) {
      if (this._tab === t) return;
      this._tab = t;
      if (t === "browse") await this._loadPool();
      this.render();
    }

    // ── Browse ────────────────────────────────────────────────────────────────
    _renderBrowse() {
      const chipBtns = [`
        <button class="chapter-add__chip ${!this._typeFilter ? "chapter-add__chip--active" : ""}"
                onclick="window.referenceGuideAddView._onTypeFilter('')">All</button>
      `, ...this._types.map((t) => `
        <button class="chapter-add__chip ${t.id === this._typeFilter ? "chapter-add__chip--active" : ""}"
                onclick="window.referenceGuideAddView._onTypeFilter('${t.id}')">
          <i data-lucide="${t.icon || "book"}" class="w-3.5 h-3.5"></i>
          ${escape(t.label)}
        </button>
      `)].join("");

      const body = this._poolLoading
        ? window.buddyLoader({ size: 80 })
        : this._pool.length === 0
          ? `<div class="text-sm opacity-60 p-6 text-center">
               No chapters available${this._search || this._typeFilter ? " for this filter" : " yet"}.
               <br/><button class="btn btn-primary btn-sm mt-3"
                            onclick="window.referenceGuideAddView._setTab('create')">
                 Create the first one
               </button>
             </div>`
          : this._groupPoolByType(this._pool)
              .map((g) => this._renderPoolSection(g)).join("");

      return `
        <div class="chapter-add__filters">
          <input type="search" class="input input-bordered input-sm chapter-add__search"
                 placeholder="Search title or content…"
                 value="${escapeAttr(this._search)}"
                 oninput="window.referenceGuideAddView._onSearchInput(this.value)" />
        </div>
        <div class="chapter-add__filter-chips" role="tablist">
          ${chipBtns}
        </div>
        ${body}
      `;
    }

    _renderPoolSection(group) {
      return `
        <section class="chapter-add__pool-section" data-type="${escapeAttr(group.type)}">
          <h4 class="chapter-add__pool-section-header">
            <i data-lucide="${group.icon}" class="w-4 h-4"></i>
            ${escape(group.label)}
          </h4>
          <ul class="chapter-add__pool">
            ${group.chapters.map((c) => this._renderPoolRow(c)).join("")}
          </ul>
        </section>
      `;
    }

    _renderPoolRow(c) {
      const icon = c.chapter_type_icon || "book";
      const author = c.created_by_name ? `by ${escape(c.created_by_name)}` : "";
      const inGuide = !!c.in_my_guide;
      // Only show the source label/dot when this view is aggregating across
      // multiple games (i.e. the caller passed expansionIds). For a plain
      // single-game add flow source_game_name is unset and we keep the row
      // chrome identical to the legacy layout.
      const sourceLabel = (this._expansionIds.length && c.source_game_name && c.source_color)
        ? `<span class="chapter-add__pool-source" style="--exp-color:${escapeAttr(c.source_color)}">
             <span class="chapter-add__pool-source-dot"></span>
             ${escape(c.source_game_name)}
           </span>`
        : "";
      // Whole row is the open-preview target. Action buttons inside stop
      // propagation so a tap on +/check/flag doesn't also open the modal.
      return `
        <li class="chapter-add__pool-row chapter-add__pool-row--clickable" data-chapter-id="${c.id}"
            role="button" tabindex="0"
            onclick="window.referenceGuideAddView._openPreview('${c.id}')"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.referenceGuideAddView._openPreview('${c.id}')}">
          <div class="chapter-add__pool-icon"><i data-lucide="${icon}" class="w-4 h-4"></i></div>
          <div class="chapter-add__pool-body">
            <div class="chapter-add__pool-title">${escape(c.title)}</div>
            <div class="chapter-add__pool-meta">
              <span class="chapter-add__pool-pop" title="${c.popularity} ${c.popularity === 1 ? "person has" : "people have"} this in their guide">
                <i data-lucide="users" class="w-3 h-3"></i> ${c.popularity}
              </span>
              ${sourceLabel}
              ${author ? `<span class="chapter-add__pool-author">${author}</span>` : ""}
            </div>
          </div>
          <div class="chapter-add__pool-actions">
            <button class="chapter-add__pool-toggle ${inGuide ? "chapter-add__pool-toggle--in" : ""}"
                    title="${inGuide ? "Remove from my guide" : "Add to my guide"}"
                    onclick="event.stopPropagation();window.referenceGuideAddView._toggleInGuide('${c.id}')">
              ${inGuide
                ? `<i data-lucide="check" class="w-4 h-4"></i><span>Added</span>`
                : `<i data-lucide="plus" class="w-4 h-4"></i>`}
            </button>
            <button class="btn btn-ghost btn-xs chapter-add__pool-report" title="Report this chapter"
                    onclick="event.stopPropagation();window.referenceGuideAddView._reportChapter('${c.id}')">
              <i data-lucide="flag" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </li>
      `;
    }

    // ── Preview modal ────────────────────────────────────────────────────────
    _renderPreviewModal() {
      if (!this._previewChapterId) return "";
      const c = this._pool.find((x) => x.id === this._previewChapterId);
      if (!c) return "";
      const icon = c.chapter_type_icon || "book";
      const author = c.created_by_name ? `by ${escape(c.created_by_name)}` : "";
      const sourceLabel = (this._expansionIds.length && c.source_game_name && c.source_color)
        ? `<span class="chapter-add__pool-source" style="--exp-color:${escapeAttr(c.source_color)}">
             <span class="chapter-add__pool-source-dot"></span>
             ${escape(c.source_game_name)}
           </span>`
        : "";
      const inGuide = !!c.in_my_guide;
      return `
        <div class="chapter-add__preview-backdrop"
             onclick="window.referenceGuideAddView._closePreview()">
          <div class="chapter-add__preview-card" role="dialog" aria-modal="true"
               onclick="event.stopPropagation()">
            <div class="chapter-add__preview-header">
              <div class="chapter-add__preview-icon"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
              <div class="chapter-add__preview-titlewrap">
                <div class="chapter-add__preview-title font-display">${escape(c.title)}</div>
                <div class="chapter-add__preview-meta">
                  <span class="chapter-add__pool-pop">
                    <i data-lucide="users" class="w-3 h-3"></i> ${c.popularity}
                  </span>
                  ${sourceLabel}
                  ${author ? `<span class="chapter-add__pool-author">${author}</span>` : ""}
                </div>
              </div>
              <button class="chapter-add__preview-close" aria-label="Close"
                      onclick="window.referenceGuideAddView._closePreview()">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
            <div class="chapter-add__preview-body scroll-chapter__content">
              ${window.renderMarkdown(c.content || "")}
            </div>
            <div class="chapter-add__preview-footer">
              <button class="chapter-add__pool-toggle ${inGuide ? "chapter-add__pool-toggle--in" : ""}"
                      onclick="window.referenceGuideAddView._toggleInGuide('${c.id}')">
                ${inGuide
                  ? `<i data-lucide="check" class="w-4 h-4"></i><span>Added</span>`
                  : `<i data-lucide="plus" class="w-4 h-4"></i><span>Add to my guide</span>`}
              </button>
              <button class="btn btn-ghost btn-sm"
                      onclick="window.referenceGuideAddView._closePreview()">Close</button>
            </div>
          </div>
        </div>
      `;
    }

    _openPreview(chapterId) {
      this._previewChapterId = chapterId;
      this.render();
    }

    _closePreview() {
      this._previewChapterId = null;
      this.render();
    }

    _onSearchInput(v) {
      this._search = v || "";
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._loadPool(), 220);
    }

    _onTypeFilter(v) {
      this._typeFilter = v || "";
      this._loadPool();
    }

    async _toggleInGuide(chapterId) {
      const row = this._pool.find((c) => c.id === chapterId);
      if (!row) return;
      // When the pool spans base + expansions each chapter carries its own
      // source_game_id. Single-game pool rows leave source_game_id null, so
      // we fall back to the base game id.
      const targetGameId = row.source_game_id || row.game_id || this._gameId;
      const targetState = !row.in_my_guide;
      try {
        if (targetState) {
          await window.Chapter.add(targetGameId, chapterId);
        } else {
          await window.Chapter.remove(targetGameId, chapterId);
        }
        row.in_my_guide = targetState;
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: targetGameId },
        }));
        showToast(targetState ? "Added to your guide" : "Removed from your guide",
                  targetState ? "success" : "info");
        this.render();
      } catch (e) {
        showToast(e.message || "Failed to update guide", "error");
      }
    }

    async _reportChapter(chapterId) {
      const reason = window.prompt(
        "Why are you reporting this chapter? (optional)",
        ""
      );
      // Null = user cancelled. Empty string = submitted without a reason.
      if (reason === null) return;
      try {
        await window.Chapter.report(chapterId, reason.trim() || null);
        showToast("Reported — thanks for flagging", "success");
      } catch (e) {
        showToast(e.message || "Failed to report chapter", "error");
      }
    }

    // ── Create ────────────────────────────────────────────────────────────────
    _renderCreate() {
      const typeBtns = this._types.map((t) => `
        <button class="chapter-add__type-btn ${t.id === this._formType ? "chapter-add__type-btn--active" : ""}"
                onclick="window.referenceGuideAddView._pickType('${t.id}')">
          <i data-lucide="${t.icon || "book"}" class="w-4 h-4"></i>
          <span>${escape(t.label)}</span>
        </button>
      `).join("");

      // Content editor: Write tab keeps the existing required textarea
      // (so HTML5 form validation still works on submit). Preview tab
      // renders the buffered markdown. Switching is purely visual —
      // _formContent stays in memory across switches.
      const isPreview = this._createSubTab === "preview";
      const editorBody = isPreview
        ? `<div class="chapter-add__preview">
             ${this._formContent.trim()
               ? window.renderMarkdown(this._formContent)
               : `<p class="opacity-60 text-sm italic">Nothing to preview yet — switch to Write and type some markdown.</p>`}
           </div>`
        : `<textarea id="chapter-form-content"
                      class="textarea textarea-bordered chapter-add__textarea"
                      rows="14" required
                      oninput="window.referenceGuideAddView._formContent = this.value"
                      placeholder="## What you can do on your turn…">${escape(this._formContent)}</textarea>`;

      // Target-game selector only renders when expansions are in scope —
      // the single-game add flow saves to the base game implicitly.
      const targetSelector = this._expansionIds.length
        ? this._renderCreateTargetSelector()
        : "";

      return `
        <form class="chapter-add__form" onsubmit="window.referenceGuideAddView._submitCreate(event)">
          ${targetSelector}
          <div class="chapter-add__field">
            <label class="chapter-add__label">Chapter type</label>
            <div class="chapter-add__type-grid">${typeBtns}</div>
          </div>
          <div class="chapter-add__field">
            <label class="chapter-add__label" for="chapter-form-title">Title</label>
            <input id="chapter-form-title" class="input input-bordered"
                   maxlength="200" required
                   value="${escapeAttr(this._formTitle)}"
                   oninput="window.referenceGuideAddView._formTitle = this.value"
                   placeholder="e.g. Turn Actions" />
          </div>
          <div class="chapter-add__field">
            <div class="chapter-add__editor-header">
              <label class="chapter-add__label">Content (Markdown)</label>
              <div class="chapter-add__editor-tabs" role="tablist">
                <button type="button" class="chapter-add__editor-tab ${!isPreview ? "is-active" : ""}"
                        onclick="window.referenceGuideAddView._setSubTab('write')">
                  <i data-lucide="pencil" class="w-3.5 h-3.5"></i> Write
                </button>
                <button type="button" class="chapter-add__editor-tab ${isPreview ? "is-active" : ""}"
                        onclick="window.referenceGuideAddView._setSubTab('preview')">
                  <i data-lucide="eye" class="w-3.5 h-3.5"></i> Preview
                </button>
              </div>
            </div>
            ${editorBody}
          </div>
          ${this._error ? `<div class="text-error text-sm">${escape(this._error)}</div>` : ""}
          <div class="chapter-add__actions">
            <button type="button" class="btn btn-ghost"
                    onclick="window.router.back('game-detail')">Cancel</button>
            <button type="submit" class="btn btn-primary"
                    ${this._saving ? "disabled" : ""}>
              ${this._saving ? "Saving…" : "Save chapter"}
            </button>
          </div>
        </form>
      `;
    }

    _renderCreateTargetSelector() {
      // Build ordered options: base game first, then expansions in the order
      // they were passed in via the route param.
      const ids = [this._gameId, ...this._expansionIds];
      const opts = ids.map((id) => {
        const meta = this._expansionMeta[id] || { name: id, color: null };
        const isActive = id === this._createTargetGameId;
        const color = meta.color || "transparent";
        return `
          <button type="button"
                  class="chapter-add__target-btn ${isActive ? "chapter-add__target-btn--active" : ""}"
                  style="--exp-color:${color}"
                  onclick="window.referenceGuideAddView._pickCreateTarget('${id}')">
            ${meta.color ? `<span class="chapter-add__target-dot"></span>` : ""}
            <span>${escape(meta.name || "Game")}</span>
          </button>
        `;
      }).join("");
      return `
        <div class="chapter-add__field">
          <label class="chapter-add__label">Save to</label>
          <div class="chapter-add__target-grid">${opts}</div>
        </div>
      `;
    }

    _pickCreateTarget(id) {
      this._createTargetGameId = id;
      this.render();
    }

    _pickType(id) {
      this._formType = id;
      this.render();
    }

    _setSubTab(t) {
      if (this._createSubTab === t) return;
      this._createSubTab = t;
      this.render();
    }

    async _submitCreate(event) {
      event.preventDefault();
      this._error = null;
      if (!this._formType) {
        this._error = "Pick a chapter type.";
        this.render();
        return;
      }
      const title = (this._formTitle || "").trim();
      const content = (this._formContent || "").trim();
      if (!title || !content) {
        this._error = "Title and content are required.";
        this.render();
        return;
      }
      this._saving = true;
      this.render();
      const targetGameId = this._createTargetGameId || this._gameId;
      try {
        await window.Chapter.create(targetGameId, {
          chapter_type: this._formType,
          title,
          content,
          layout: "text",
        });
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: targetGameId },
        }));
        showToast("Chapter added to your guide", "success");
        this._formTitle = "";
        this._formContent = "";
        this._formType = "";
        window.router.back("game-detail");
      } catch (e) {
        this._error = e.message || "Failed to create chapter";
        this._saving = false;
        this.render();
      }
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.ReferenceGuideAddView = ReferenceGuideAddView;
})();
