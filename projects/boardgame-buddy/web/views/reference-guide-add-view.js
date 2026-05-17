// views/reference-guide-add-view.js — add a chapter to the user's
// reference guide for a game. Two tabs: Create (author new) or Browse
// (pick from the community pool, sorted by popularity).

(function () {
  class ReferenceGuideAddView extends window.View {
    constructor() {
      super("reference-guide-add");
      this._tab = "browse";          // "browse" | "create"
      this._gameId = null;
      this._gameName = "";

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
      this._saving = false;
      this._error = null;
    }

    async onMount() {
      this._gameId = (this.params && this.params.gameId) || null;
      this._gameName = (this.params && this.params.gameName) || "";
      this._tab = (this.params && this.params.tab) || "browse";
      if (!this._gameId) {
        this.render();
        return;
      }
      // Always preload chapter types — they're needed by both tabs.
      try { this._types = await window.Chapter.types(); }
      catch (_) { this._types = []; }
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
        });
        this._pool = (pool || []).filter((c) => !c.in_my_guide);
      } catch (e) {
        showToast(e.message || "Failed to load chapter pool", "error");
        this._pool = [];
      } finally {
        this._poolLoading = false;
        this.render();
      }
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
      const typeOpts = this._types.map((t) =>
        `<option value="${escapeAttr(t.id)}" ${t.id === this._typeFilter ? "selected" : ""}>${escape(t.label)}</option>`
      ).join("");
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
          : `<ul class="chapter-add__pool">
               ${this._pool.map((c) => this._renderPoolRow(c)).join("")}
             </ul>`;
      return `
        <div class="chapter-add__filters">
          <input type="search" class="input input-bordered input-sm chapter-add__search"
                 placeholder="Search title or content…"
                 value="${escapeAttr(this._search)}"
                 oninput="window.referenceGuideAddView._onSearchInput(this.value)" />
          <select class="select select-bordered select-sm"
                  onchange="window.referenceGuideAddView._onTypeFilter(this.value)">
            <option value="">All types</option>
            ${typeOpts}
          </select>
        </div>
        ${body}
      `;
    }

    _renderPoolRow(c) {
      const icon = c.chapter_type_icon || "book";
      const author = c.created_by_name ? `by ${escape(c.created_by_name)}` : "";
      const previewSrc = c.content || "";
      const preview = previewSrc.length > 160
        ? escape(previewSrc.slice(0, 160)) + "…"
        : escape(previewSrc);
      return `
        <li class="chapter-add__pool-row" data-chapter-id="${c.id}">
          <div class="chapter-add__pool-icon"><i data-lucide="${icon}" class="w-4 h-4"></i></div>
          <div class="chapter-add__pool-body">
            <div class="chapter-add__pool-title">${escape(c.title)}</div>
            <div class="chapter-add__pool-meta">
              <span class="chapter-add__pool-type">${escape(c.chapter_type_label || c.chapter_type)}</span>
              <span class="chapter-add__pool-pop" title="${c.popularity} ${c.popularity === 1 ? "person has" : "people have"} this in their guide">
                <i data-lucide="users" class="w-3 h-3"></i> ${c.popularity}
              </span>
              ${author ? `<span class="chapter-add__pool-author">${author}</span>` : ""}
            </div>
            ${preview ? `<div class="chapter-add__pool-preview">${preview}</div>` : ""}
          </div>
          <div class="chapter-add__pool-actions">
            <button class="btn btn-primary btn-sm" title="Add to my guide"
                    onclick="window.referenceGuideAddView._addChapter('${c.id}')">
              <i data-lucide="plus" class="w-4 h-4"></i>
            </button>
            <button class="btn btn-ghost btn-xs chapter-add__pool-report" title="Report this chapter"
                    onclick="window.referenceGuideAddView._reportChapter('${c.id}')">
              <i data-lucide="flag" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </li>
      `;
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

    async _addChapter(chapterId) {
      try {
        await window.Chapter.add(this._gameId, chapterId);
        this._pool = this._pool.filter((c) => c.id !== chapterId);
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: this._gameId },
        }));
        showToast("Added to your guide", "success");
        this.render();
      } catch (e) {
        showToast(e.message || "Failed to add chapter", "error");
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
      return `
        <form class="chapter-add__form" onsubmit="window.referenceGuideAddView._submitCreate(event)">
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
            <label class="chapter-add__label" for="chapter-form-content">Content (Markdown)</label>
            <textarea id="chapter-form-content"
                      class="textarea textarea-bordered chapter-add__textarea"
                      rows="12" required
                      oninput="window.referenceGuideAddView._formContent = this.value"
                      placeholder="## What you can do on your turn…">${escape(this._formContent)}</textarea>
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

    _pickType(id) {
      this._formType = id;
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
      try {
        await window.Chapter.create(this._gameId, {
          chapter_type: this._formType,
          title,
          content,
          layout: "text",
        });
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: this._gameId },
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
