// views/reference-guide-add-view.js — add or edit a chapter in the user's
// reference guide. Three tabs/modes share one surface:
//   - "browse" : parchment scroll of community chapters; rows expand inline
//                to preview content + Add/Added toggle + Report.
//   - "create" : full Option C editor (Write/Preview toggle, format toolbar,
//                table picker, color swatches) for authoring a new chapter.
//   - "edit"   : same Option C editor, prefilled from a stashed chapter; Save
//                calls PATCH /chapters/{id} instead of POST.

(function () {
  // Inline color swatches — hex values map straight into the existing
  // <span style="color:#hex"> markdown renderer (see ui/markdown.js).
  const COLOR_SWATCHES = [
    { id: "gold",   hex: "#C9922A" },
    { id: "green",  hex: "#4A7A4A" },
    { id: "blue",   hex: "#4A6F94" },
    { id: "rust",   hex: "#A65D2C" },
    { id: "purple", hex: "#7A5293" },
  ];

  class ReferenceGuideAddView extends window.View {
    constructor() {
      super("reference-guide-add");
      this._tab = "browse";          // "browse" | "create" | "edit"
      this._gameId = null;            // base game uuid (route param)
      this._gameName = "";
      this._gameThumb = null;         // base game thumbnail_url
      // Optional expansion uuids passed from the in-play guide widget. When
      // present, Browse shows chapters across base + these expansions and the
      // Create tab gets a "Target game" picker so the new chapter can be
      // saved against an expansion's pool.
      this._expansionIds = [];
      this._expansionMeta = {};       // gameId → {name, color, thumb}
      this._createTargetGameId = null; // defaults to base game in onMount

      // Browse state
      this._poolLoading = false;
      this._pool = [];
      this._search = "";
      this._typeFilter = "";

      // Create/Edit form state
      this._types = [];
      this._formType = "";
      this._formTitle = "";
      this._formContent = "";
      this._editorView = "write"; // "write" | "preview"
      this._saving = false;
      this._error = null;
      this._editingChapterId = null;  // set when _tab === "edit"
      // True only when edit mode was entered via an external route (e.g.
      // the reference-guide-scroll Edit button on game-detail). Cancel /
      // Save in that case pops back to the prior view. In-view edit
      // transitions (FAB / expanded-row Edit) leave this false so the
      // user returns to browse instead.
      this._externalEdit = false;
      // Transient stash: scroll widget drops the chapter here before
      // routing into edit mode so we don't need an extra GET.
      this._prefillChapter = null;
      // Active toolbar popover: null | "table" | "color"
      this._activePop = null;
      // Live dimension label for the table picker.
      this._tablePickLabel = "1 × 1";
    }

    async onMount() {
      const p = this.params || {};
      this._gameId = p.gameId || null;
      this._gameName = p.gameName || "";
      const rawExp = p.expansionIds || "";
      this._expansionIds = rawExp.split(",").map((s) => s.trim()).filter(Boolean);
      this._createTargetGameId = this._gameId;
      this._expansionMeta = this._gameId
        ? { [this._gameId]: { name: this._gameName, color: null, thumb: null } }
        : {};

      // Global key handlers: Escape closes any open toolbar popover.
      this.listenDom("keydown", (e) => {
        if (e.key === "Escape" && this._activePop) {
          this._activePop = null;
          this.render();
        }
      });
      // Click outside any popover closes it (toolbar buttons stopPropagate).
      this.listenDom("click", (e) => {
        if (!this._activePop) return;
        if (e.target.closest(".chapter-edit__pop")) return;
        if (e.target.closest("[data-pop-trigger]")) return;
        this._activePop = null;
        this.render();
      });

      if (!this._gameId) {
        this.render();
        return;
      }

      // Always preload chapter types — both create and browse need them.
      // Fetch game + expansion metadata in parallel so the cream game chip
      // and the target-game selector can render thumbnails on first paint.
      const typesP = window.Chapter.types().catch(() => []);
      const gameP = window.api.get(`/games/${this._gameId}`).catch(() => null);
      const expsP = this._expansionIds.length
        ? window.api.get(`/games/${this._gameId}/expansions`).catch(() => [])
        : Promise.resolve([]);
      const [types, game, exps] = await Promise.all([typesP, gameP, expsP]);
      this._types = types || [];
      if (game) {
        this._gameThumb = game.thumbnail_url || game.image_url || null;
        this._expansionMeta[this._gameId] = {
          name: game.name || this._gameName,
          color: null,
          thumb: this._gameThumb,
        };
        if (!this._gameName) this._gameName = game.name || "";
      }
      for (const e of (exps || [])) {
        if (this._expansionIds.includes(e.expansion_game_id)) {
          this._expansionMeta[e.expansion_game_id] = {
            name: e.name,
            color: e.color || null,
            thumb: e.thumbnail_url || null,
          };
        }
      }

      // External edit entry: the user clicked Edit on a chapter in their
      // reference-guide-scroll widget (on a separate view). That route
      // stashes the chapter and passes mode=edit. Cancel/Save in this case
      // pops back to the prior view (typically game-detail).
      // In-view transitions (FAB → create, expanded-row Edit → edit) flip
      // _tab directly without re-routing, leaving _externalEdit false so
      // Cancel returns to browse instead of game-detail.
      if (p.mode === "edit" && this._prefillChapter) {
        const c = this._prefillChapter;
        this._prefillChapter = null;
        this._editingChapterId = c.id;
        this._formTitle = c.title || "";
        this._formContent = c.content || "";
        this._formType = c.chapter_type || "";
        this._createTargetGameId = c.source_game_id || c.game_id || this._gameId;
        this._editorView = "write";
        this._error = null;
        this._tab = "edit";
        this._externalEdit = true;
      } else {
        // Fresh mount (or stale edit URL with no stash) lands on browse.
        this._tab = "browse";
        this._externalEdit = false;
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
        this._pool = pool || [];
      } catch (e) {
        showToast(e.message || "Failed to load chapter pool", "error");
        this._pool = [];
      } finally {
        this._poolLoading = false;
        this.render();
      }
    }

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

      const isEditing = this._tab === "edit";
      const isCreating = this._tab === "create";
      const isBrowsing = this._tab === "browse";
      const headerTitle = isEditing ? "Edit chapter"
                          : isCreating ? "New chapter"
                          : "Add a chapter";
      // Back arrow in browse pops to the prior view (game-detail). In
      // create/edit it cancels the in-progress draft instead — same
      // behaviour as the Cancel button, no rogue back-navigation.
      const backHandler = isBrowsing
        ? "window.router.back('game-detail')"
        : "window.referenceGuideAddView._cancelForm()";

      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="${backHandler}">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="font-display font-semibold text-lg">${escape(headerTitle)}</h2>
          <span></span>
        </header>
        ${this._renderGameChip()}
        ${isBrowsing
            ? this._renderBrowse()
            : this._renderEditor(isEditing)}
      `;
      if (window.lucide) window.lucide.createIcons();

      // Wire <details> mutex per section (only one open chapter per type).
      this.container.querySelectorAll(".scroll-chapter-list").forEach((list) => {
        list.addEventListener("toggle", (ev) => {
          const opened = ev.target;
          if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
          list.querySelectorAll("details[open]").forEach((d) => {
            if (d !== opened) d.open = false;
          });
        }, true);
      });

      // Build the table dimension picker grid (lazy — only when popover is
      // open, to keep the DOM cheap on first paint).
      if (this._activePop === "table") this._buildTableGrid();
    }

    // Game chip — cream pill with cover + name. Especially important in
    // create / edit modes so the player can never forget which game the
    // chapter belongs to.
    _renderGameChip() {
      const meta = this._expansionMeta[this._gameId] || { name: this._gameName, thumb: this._gameThumb };
      const name = meta.name || this._gameName || "Reference guide";
      const thumb = meta.thumb || this._gameThumb;
      const sub = this._tab === "edit"
        ? "Editing chapter for this game"
        : (this._tab === "create" ? "New chapter for this game" : "Chapters for this game");
      const cover = thumb
        ? `<div class="chapter-edit__gamechip-cv"><img src="${escapeAttr(thumb)}" alt="" onerror="this.parentNode.classList.add('chapter-edit__gamechip-cv--blank')"></div>`
        : `<div class="chapter-edit__gamechip-cv chapter-edit__gamechip-cv--blank"></div>`;
      return `
        <div class="chapter-edit__gamechip">
          ${cover}
          <div class="chapter-edit__gamechip-text">
            <div class="chapter-edit__gamechip-name">${escape(name)}</div>
            <div class="chapter-edit__gamechip-sub">${escape(sub)}</div>
          </div>
        </div>
      `;
    }

    // FAB → create. Clears any leftover form buffer so the editor always
    // opens clean (the prior flow let create-tab state persist across
    // browse/create toggles, which made entering Create feel stale).
    _enterCreate() {
      this._editingChapterId = null;
      this._formTitle = "";
      this._formContent = "";
      this._formType = "";
      this._editorView = "write";
      this._error = null;
      this._activePop = null;
      this._tab = "create";
      this._externalEdit = false;
      this.render();
    }

    // Internal exit: returns to browse without disturbing the router stack.
    async _backToBrowse() {
      this._editingChapterId = null;
      this._formTitle = "";
      this._formContent = "";
      this._formType = "";
      this._error = null;
      this._activePop = null;
      this._tab = "browse";
      this._externalEdit = false;
      await this._loadPool();
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

      const scrollBody = this._poolLoading
        ? `<div class="scroll-panel__loading">${window.buddyLoader({ size: 60 })}</div>`
        : this._pool.length === 0
          ? `<div class="scroll-panel__empty">
               No chapters available${this._search || this._typeFilter ? " for this filter" : " yet"}.
               <br/><button class="chapter-edit__fbtn chapter-edit__fbtn--save mt-3"
                            onclick="window.referenceGuideAddView._enterCreate()">
                 Create the first one
               </button>
             </div>`
          : this._groupPoolByType(this._pool)
              .map((g) => this._renderPoolSection(g)).join("");

      return `
        <div class="chapter-add__filter-chips" role="tablist">
          ${chipBtns}
        </div>
        <div class="scroll-panel chapter-add__pool-scroll">
          <div class="scroll-panel__peek">
            <div class="scroll-panel__search-row">
              <i data-lucide="search" class="w-4 h-4 scroll-panel__search-icon"></i>
              <input class="scroll-panel__search"
                     type="search"
                     placeholder="Search chapters…"
                     value="${escapeAttr(this._search)}"
                     oninput="window.referenceGuideAddView._onSearchInput(this.value)" />
            </div>
          </div>
          <div class="scroll-panel__body">
            ${scrollBody}
          </div>
        </div>
        <button class="chapter-add__fab"
                title="Create a new chapter"
                onclick="window.referenceGuideAddView._enterCreate()">
          <i data-lucide="plus" class="w-5 h-5"></i>
          <span>New chapter</span>
        </button>
      `;
    }

    _renderPoolSection(group) {
      return `
        <section class="scroll-section" data-type="${escapeAttr(group.type)}">
          <h4 class="scroll-section__header">
            <i data-lucide="${group.icon}" class="w-4 h-4"></i>
            ${escape(group.label)}
          </h4>
          <ul class="scroll-chapter-list">
            ${group.chapters.map((c) => this._renderPoolRow(c)).join("")}
          </ul>
        </section>
      `;
    }

    _renderPoolRow(c) {
      const icon = c.chapter_type_icon || "book";
      const author = c.created_by_name ? `by ${escape(c.created_by_name)}` : "";
      const inGuide = !!c.in_my_guide;
      const me = window.store && window.store.get("user");
      const isAuthed = !!me;
      const isOwner = !!(me && c.created_by && me.id === c.created_by);
      const dot = (this._expansionIds.length && c.source_color)
        ? `<span class="scroll-chapter__source-dot" style="--exp-color:${escapeAttr(c.source_color)}"
                 title="${escapeAttr(c.source_game_name || "")}"></span>`
        : "";
      // Add/Added toggle lives on the right of the summary so a user can
      // grab a chapter without having to expand it first. preventDefault +
      // stopPropagation stop the toggle click from also flipping <details>.
      const toggleBtn = `
        <button class="chapter-add__pool-toggle chapter-add__pool-toggle--compact ${inGuide ? "chapter-add__pool-toggle--in" : ""}"
                title="${inGuide ? "Remove from my guide" : "Add to my guide"}"
                onclick="event.preventDefault();event.stopPropagation();window.referenceGuideAddView._toggleInGuide('${c.id}')">
          ${inGuide
            ? `<i data-lucide="check" class="w-4 h-4"></i><span>Added</span>`
            : `<i data-lucide="plus" class="w-4 h-4"></i><span>Add</span>`}
        </button>
      `;

      return `
        <li class="scroll-chapter" data-chapter-id="${c.id}">
          <details>
            <summary class="scroll-chapter__summary scroll-chapter__summary--rich">
              ${dot}
              <span class="scroll-chapter__icon"><i data-lucide="${icon}" class="w-4 h-4"></i></span>
              <div class="scroll-chapter__summary-text">
                <div class="scroll-chapter__title">${escape(c.title)}</div>
                <div class="scroll-chapter__submeta">
                  <span class="scroll-chapter__pop" title="${c.popularity} ${c.popularity === 1 ? "person has" : "people have"} this in their guide">
                    <i data-lucide="users" class="w-3 h-3"></i> ${c.popularity}
                  </span>
                  ${author ? `<span class="scroll-chapter__author">${author}</span>` : ""}
                </div>
              </div>
              ${toggleBtn}
            </summary>
            <div class="scroll-chapter__content">${window.renderMarkdown(c.content || "")}</div>
            <div class="scroll-chapter__actions">
              ${isOwner ? `
                <button class="btn btn-ghost btn-xs"
                        onclick="event.preventDefault();window.referenceGuideAddView._editFromPool('${c.id}')">
                  <i data-lucide="pencil" class="w-3.5 h-3.5"></i> Edit
                </button>
              ` : ""}
              ${isAuthed && !isOwner ? `
                <button class="btn btn-ghost btn-xs"
                        onclick="event.preventDefault();window.referenceGuideAddView._reportChapter('${c.id}')">
                  <i data-lucide="flag" class="w-3.5 h-3.5"></i> Report
                </button>
              ` : ""}
            </div>
          </details>
        </li>
      `;
    }

    // In-view edit transition: no routing, no _externalEdit flag → Cancel
    // and Save return to browse instead of popping the router stack.
    _editFromPool(chapterId) {
      const c = this._pool.find((x) => x.id === chapterId);
      if (!c) return;
      this._editingChapterId = c.id;
      this._formTitle = c.title || "";
      this._formContent = c.content || "";
      this._formType = c.chapter_type || "";
      this._createTargetGameId = c.source_game_id || c.game_id || this._gameId;
      this._editorView = "write";
      this._error = null;
      this._activePop = null;
      this._tab = "edit";
      this._externalEdit = false;
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
      if (reason === null) return;
      try {
        await window.Chapter.report(chapterId, reason.trim() || null);
        showToast("Reported — thanks for flagging", "success");
      } catch (e) {
        showToast(e.message || "Failed to report chapter", "error");
      }
    }

    // ── Create / Edit (shared editor surface) ─────────────────────────────────
    _renderEditor(isEditing) {
      const typeBtns = this._types.map((t) => `
        <button type="button"
                class="chapter-edit__tpill ${t.id === this._formType ? "chapter-edit__tpill--on" : ""}"
                onclick="window.referenceGuideAddView._pickType('${t.id}')">
          <i data-lucide="${t.icon || "book"}" class="w-4 h-4"></i>
          <span>${escape(t.label)}</span>
        </button>
      `).join("");

      const targetSelector = this._expansionIds.length
        ? this._renderCreateTargetSelector()
        : "";

      const isPreview = this._editorView === "preview";

      const editorPanel = isPreview
        ? `<div class="chapter-edit__preview">
             ${this._formContent.trim()
               ? window.renderMarkdown(this._formContent)
               : `<p class="chapter-edit__preview-empty">Nothing to preview yet — switch to Write and start typing.</p>`}
           </div>`
        : `<div class="chapter-edit__write">
             <div class="chapter-edit__toolbar">
               <button type="button" class="chapter-edit__tbtn" title="Heading"
                       onclick="window.referenceGuideAddView._fmt('h')">H</button>
               <button type="button" class="chapter-edit__tbtn" title="Bold"
                       onclick="window.referenceGuideAddView._fmt('b')"><b>B</b></button>
               <button type="button" class="chapter-edit__tbtn chapter-edit__tbtn--ital" title="Italic"
                       onclick="window.referenceGuideAddView._fmt('i')">I</button>
               <span class="chapter-edit__tdiv"></span>
               <button type="button" class="chapter-edit__tbtn" title="Bulleted list"
                       onclick="window.referenceGuideAddView._fmt('ul')">
                 <i data-lucide="list" class="w-4 h-4"></i>
               </button>
               <button type="button" class="chapter-edit__tbtn" title="Link"
                       onclick="window.referenceGuideAddView._fmt('link')">
                 <i data-lucide="link" class="w-4 h-4"></i>
               </button>
               <button type="button" class="chapter-edit__tbtn" data-pop-trigger title="Insert table"
                       onclick="event.stopPropagation();window.referenceGuideAddView._togglePop('table')">
                 <i data-lucide="table" class="w-4 h-4"></i>
               </button>
               <button type="button" class="chapter-edit__tbtn chapter-edit__tbtn--gold"
                       data-pop-trigger title="Text colour"
                       onclick="event.stopPropagation();window.referenceGuideAddView._togglePop('color')">
                 <i data-lucide="palette" class="w-4 h-4"></i>
               </button>
             </div>
             <textarea id="chapter-form-content"
                       class="chapter-edit__mdarea"
                       rows="14" required
                       spellcheck="false"
                       oninput="window.referenceGuideAddView._formContent = this.value"
                       placeholder="## What you can do on your turn…">${escape(this._formContent)}</textarea>
             ${this._renderPopovers()}
           </div>`;

      const importBtn = isEditing ? "" : `
        <label class="chapter-edit__import" title="Import a .md file as this chapter">
          <input type="file" accept=".md,text/markdown,text/plain"
                 onchange="window.referenceGuideAddView._onImportMd(event)" />
          <i data-lucide="upload" class="w-3.5 h-3.5"></i>
          <span>Import .md</span>
        </label>
      `;

      const submitLabel = isEditing
        ? (this._saving ? "Saving…" : "Save changes")
        : (this._saving ? "Saving…" : "Save chapter");

      return `
        <form class="chapter-edit__form" onsubmit="window.referenceGuideAddView._submitForm(event)">
          ${targetSelector}

          <div class="chapter-edit__titlerow">
            <input id="chapter-form-title" class="chapter-edit__titlefield"
                   maxlength="200" required
                   value="${escapeAttr(this._formTitle)}"
                   oninput="window.referenceGuideAddView._formTitle = this.value"
                   placeholder="Chapter title…" />
            ${importBtn}
          </div>

          <div class="chapter-edit__typescroll">${typeBtns}</div>

          <div class="chapter-edit__seg">
            <button type="button" class="${!isPreview ? "on" : ""}"
                    onclick="window.referenceGuideAddView._setEditorView('write')">
              <i data-lucide="pencil" class="w-4 h-4"></i> Write
            </button>
            <button type="button" class="${isPreview ? "on" : ""}"
                    onclick="window.referenceGuideAddView._setEditorView('preview')">
              <i data-lucide="eye" class="w-4 h-4"></i> Preview
            </button>
          </div>

          ${editorPanel}

          ${this._error ? `<div class="text-error text-sm chapter-edit__error">${escape(this._error)}</div>` : ""}

          <div class="chapter-edit__footer">
            <button type="button" class="chapter-edit__fbtn chapter-edit__fbtn--cancel"
                    onclick="window.referenceGuideAddView._cancelForm()">Cancel</button>
            <button type="submit" class="chapter-edit__fbtn chapter-edit__fbtn--save"
                    ${this._saving ? "disabled" : ""}>
              ${escape(submitLabel)}
            </button>
          </div>
        </form>
      `;
    }

    _renderCreateTargetSelector() {
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
        <div class="chapter-edit__field">
          <label class="chapter-edit__label">Save to</label>
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

    _setEditorView(v) {
      if (this._editorView === v) return;
      this._editorView = v;
      // Close any open popover when toggling — they're write-mode only.
      this._activePop = null;
      this.render();
    }

    // ── Formatting helpers (ported from the Option C mock) ─────────────────────
    _getTextarea() {
      return this.container.querySelector("#chapter-form-content");
    }

    _applyWrap(before, after) {
      const ta = this._getTextarea();
      if (!ta) return;
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || "text";
      const next = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
      ta.value = next;
      this._formContent = next;
      ta.focus();
      ta.selectionStart = s + before.length;
      ta.selectionEnd = s + before.length + sel.length;
    }

    _applyLinePrefix(prefix) {
      const ta = this._getTextarea();
      if (!ta) return;
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
      const next = ta.value.slice(0, lineStart) + prefix + ta.value.slice(lineStart);
      ta.value = next;
      this._formContent = next;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + prefix.length;
    }

    _insertAt(text) {
      const ta = this._getTextarea();
      if (!ta) return;
      const s = ta.selectionStart;
      const next = ta.value.slice(0, s) + text + ta.value.slice(s);
      ta.value = next;
      this._formContent = next;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + text.length;
    }

    _fmt(kind) {
      switch (kind) {
        case "b":    this._applyWrap("**", "**"); break;
        case "i":    this._applyWrap("*", "*"); break;
        case "h":    this._applyLinePrefix("## "); break;
        case "ul":   this._applyLinePrefix("- "); break;
        case "link": this._applyWrap("[", "](url)"); break;
      }
    }

    _applyColor(hex) {
      this._applyWrap(`<span style="color:${hex}">`, "</span>");
      this._activePop = null;
      this.render();
    }

    _insertTable(cols, rows) {
      const head = "| " + Array.from({ length: cols }, (_, i) => "Col " + (i + 1)).join(" | ") + " |\n";
      const sep  = "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |\n";
      let body = "";
      for (let r = 0; r < rows; r++) {
        body += "| " + Array.from({ length: cols }, () => "   ").join(" | ") + " |\n";
      }
      this._insertAt("\n" + head + sep + body + "\n");
      this._activePop = null;
      this.render();
    }

    _togglePop(name) {
      this._activePop = this._activePop === name ? null : name;
      this._tablePickLabel = "1 × 1";
      this.render();
    }

    _renderPopovers() {
      if (this._activePop === "table") {
        return `
          <div class="chapter-edit__pop chapter-edit__pop--table">
            <div class="chapter-edit__pop-head">Insert table · <span class="chapter-edit__pop-dim" id="table-pick-label">${escape(this._tablePickLabel)}</span></div>
            <div class="chapter-edit__tgrid" id="table-pick-grid"></div>
          </div>
        `;
      }
      if (this._activePop === "color") {
        return `
          <div class="chapter-edit__pop chapter-edit__pop--color">
            <div class="chapter-edit__pop-head">Text colour</div>
            <div class="chapter-edit__swatches">
              ${COLOR_SWATCHES.map((s) => `
                <button type="button" class="chapter-edit__sw"
                        style="background:${s.hex}"
                        title="${s.id}"
                        onclick="event.stopPropagation();window.referenceGuideAddView._applyColor('${s.hex}')"></button>
              `).join("")}
            </div>
          </div>
        `;
      }
      return "";
    }

    _buildTableGrid() {
      const grid = this.container.querySelector("#table-pick-grid");
      const label = this.container.querySelector("#table-pick-label");
      if (!grid || !label) return;
      grid.innerHTML = "";
      const ROWS = 6, COLS = 6;
      for (let r = 1; r <= ROWS; r++) {
        for (let c = 1; c <= COLS; c++) {
          const cell = document.createElement("div");
          cell.className = "chapter-edit__cell";
          cell.dataset.r = String(r);
          cell.dataset.c = String(c);
          cell.addEventListener("mouseenter", () => {
            grid.querySelectorAll(".chapter-edit__cell").forEach((x) => {
              x.classList.toggle(
                "chapter-edit__cell--hot",
                Number(x.dataset.r) <= r && Number(x.dataset.c) <= c
              );
            });
            label.textContent = c + " × " + r;
          });
          cell.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this._insertTable(c, r);
          });
          grid.appendChild(cell);
        }
      }
    }

    _onImportMd(event) {
      const file = event.target && event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        // Strip BOM, normalize newlines.
        const lines = text.replace(/^﻿/, "").split(/\r?\n/);
        // Find first H1 — promote it to the title, drop the rest into content.
        let titleLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^#\s+\S/.test(lines[i])) { titleLine = i; break; }
          if (lines[i].trim() && !/^\s*$/.test(lines[i])) break;
        }
        if (titleLine >= 0) {
          const title = lines[titleLine].replace(/^#\s+/, "").trim();
          if (!this._formTitle.trim()) this._formTitle = title.slice(0, 200);
          const rest = lines.slice(titleLine + 1).join("\n").replace(/^\s+/, "");
          this._formContent = rest;
        } else {
          this._formContent = text;
        }
        this.render();
      };
      reader.onerror = () => showToast("Failed to read file", "error");
      reader.readAsText(file);
      // Reset the input so the same file can be re-imported next time.
      event.target.value = "";
    }

    async _cancelForm() {
      // External edit (arrived via route with mode=edit) pops back to the
      // prior view. In-view create / in-view edit return to browse.
      if (this._externalEdit) {
        window.router.back("game-detail");
        return;
      }
      await this._backToBrowse();
      this.render();
    }

    async _submitForm(event) {
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
      const isEditing = this._tab === "edit";
      const externalEdit = this._externalEdit;
      const targetGameId = this._createTargetGameId || this._gameId;
      try {
        if (isEditing) {
          await window.Chapter.update(this._editingChapterId, {
            chapter_type: this._formType,
            title,
            content,
          });
          showToast("Chapter updated", "success");
        } else {
          await window.Chapter.create(targetGameId, {
            chapter_type: this._formType,
            title,
            content,
            layout: "text",
          });
          showToast("Chapter added to your guide", "success");
        }
        document.dispatchEvent(new CustomEvent("chapters-changed", {
          detail: { gameId: targetGameId },
        }));
        this._saving = false;
        if (externalEdit) {
          // Came from the scroll widget on another view — return there so
          // the user lands back where they started.
          window.router.back("game-detail");
        } else {
          await this._backToBrowse();
          this.render();
        }
      } catch (e) {
        this._error = e.message || "Failed to save chapter";
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
