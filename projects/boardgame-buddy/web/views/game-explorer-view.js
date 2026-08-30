// views/game-explorer-view.js — "Find a game that fits" browser.
//
// A simplified game explorer: My Collection ↔ All BgB Games toggle plus
// players / play time / game-type filters, rendering a paginated 3×3 grid of
// Polaroid-style cards. Tapping a card stages the pick in the active
// PlaySession and jumps straight into the Gather screen of the host flow —
// the game arrives prefilled.
//
// Reached from the Play tab's "Game Explorer" host card. Lived as the bottom
// half of the Play tab until Join moved down there; the markup and the filter
// semantics are unchanged by that move.

(function () {
  const PER_PAGE = 9;

  // Catalog pages: viewer-independent, changes only when a game is imported.
  const CATALOG_NS = "game.explorer";
  const CATALOG_FRESH_TTL_MS = 3 * 60 * 1000;
  const CATALOG_STALE_TTL_MS = 30 * 60 * 1000;

  // Playtime preset bubbles. Inclusive min/max — matches the backend filter
  // (`gte(min) / lte(max)`), so a 60-min game shows up in both the "30–60"
  // and "60–90" buckets. Acceptable for a filter UI.
  const PLAYTIME_BUCKETS = [
    { id: "u30",    label: "< 30m",     min: null, max: 29 },
    { id: "30-60",  label: "30–60m",    min: 30,   max: 60 },
    { id: "60-90",  label: "60–90m",    min: 60,   max: 90 },
    { id: "90-120", label: "90–120m",   min: 90,   max: 120 },
    { id: "o120",   label: "2+ hours",  min: 120,  max: null },
  ];

  // Same predicate the collection spokes use. The bucket bounds here are
  // identical to ShelfFilter.PLAYTIME_BUCKETS; only the labels are shorter,
  // because this grid is tighter.
  const isActiveBucket = window.ShelfFilter.isActiveBucket;

  class GameExplorerView extends window.View {
    constructor() {
      super("game-explorer");
      this._filters = this._emptyFilters();
      // Monotonic: a load resolving after a newer one (rapid scope/filter
      // taps) must not write its result back.
      this._loadSeq = 0;
      // Memo for _sortedShelf: the shelf object it was derived from, and the
      // sorted copy. Identity comparison, so a refreshed shelf re-sorts once.
      this._sortedSrc = null;
      this._sorted = [];
      this._page = 1;
      this._games = [];
      this._total = 0;
      this._loading = false;
      this._error = null;
      this._scopeAutoSwitched = false;
      // Per-game owned/wishlist/played status map. Populated from
      // Collection.myStatusMap() on mount; patched live by status-changed
      // CustomEvents fired from the status sheet.
      this._collectionMap = {};
    }

    _emptyFilters() {
      return {
        scope: "mine",        // 'mine' | 'all'
        players: null,
        playtimeMin: null,
        playtimeMax: null,
        playMode: null,        // null | 'competitive' | 'coop' | 'team'
      };
    }

    _hydrateFromCache() {
      this._collectionMap =
        window.store.get("myCollectionMap")
        || (window.Collection.cachedStatusMap && window.Collection.cachedStatusMap())
        || {};
    }

    // View.mount() calls this synchronously before onMount(), so the header and
    // the filter chips are on screen in the tap frame; only the grid below
    // waits on the network. Deliberately does NOT reset _filters / _page /
    // _games: a return visit repaints the user's last filter state instantly.
    renderLoading() {
      this._hydrateFromCache();
      this._error = null;
      // Try the cached shelf before committing to a loading state, so a return
      // visit repaints the user's last filter state with real cards instead of
      // flashing a spinner over them.
      if (this._filters.scope === "mine" && this._paintMineFromCache()) return;
      this._loading = true;
      this.render();
    }

    async onMount() {
      // Keep the polaroid status badges in sync with any other view that
      // mutates the user's collection (game-detail status picker, profile
      // grid, etc.). The status-tag picker dispatches `status-changed` on
      // document; the shared collection cache also pushes into the store.
      // Both of these fire for a single "+" tap (the status picker sets the
      // store slot AND dispatches the DOM event), so each one patches rather
      // than re-rendering — two full rebuilds for one tap was the old cost.
      this.listen("myCollectionMap", (m) => {
        this._collectionMap = m || {};
        this._paintCardStatuses();
      });
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = (e && e.detail) || {};
        if (!gameId) return;
        if (status == null) delete this._collectionMap[gameId];
        else this._collectionMap[gameId] = status;
        this._paintCardStatuses();
      });
      // renderLoading() already painted from cache one frame ago (it runs
      // synchronously just before this). Re-hydrating is idempotent and covers
      // the case where that call threw.
      this._hydrateFromCache();

      // Unawaited and independent: the status map only feeds badges on the
      // grid, so the filters must not wait on it.
      window.Collection.myStatusMap()
        .then((m) => {
          if (!this._mounted || !m) return;
          this._collectionMap = m;
          this.render();
        })
        .catch(() => {});
      this._loadGames();
    }

    /** The filter set, in the shape ShelfFilter understands. */
    _filterSpec() {
      const f = this._filters;
      return {
        search: null,
        players: f.players,
        playtimeMin: f.playtimeMin,
        playtimeMax: f.playtimeMax,
        playMode: f.playMode,
        excludeExpansions: true,
      };
    }

    _queryString({ page = this._page } = {}) {
      const qs = new URLSearchParams();
      qs.set("page", String(page));
      qs.set("per_page", String(PER_PAGE));
      qs.set("exclude_expansions", "true");
      // The polaroid never renders expansion_count, and computing it costs the
      // endpoint a whole second round trip per page. Opt out.
      qs.set("include_expansion_counts", "false");
      if (this._filters.players) qs.set("players", String(this._filters.players));
      if (this._filters.playtimeMin != null) qs.set("playtime_min", String(this._filters.playtimeMin));
      if (this._filters.playtimeMax != null) qs.set("playtime_max", String(this._filters.playtimeMax));
      if (this._filters.playMode) qs.set("play_mode", this._filters.playMode);
      return qs.toString();
    }

    /**
     * Every mount, scope toggle, filter chip and page turn — including Prev —
     * used to be its own uncached round trip. The "mine" scope is just the
     * owned shelf, which bootstrap already warms, so it pages locally through
     * ShelfFilter; the catalog scope is cached per query instead.
     */
    async _loadGames() {
      const seq = ++this._loadSeq;

      // Warm path first, and SYNCHRONOUSLY. _loadGames used to set
      // _loading = true and render before it knew whether the data was local,
      // so a chip tap on an already-cached shelf paid two full paints for a
      // loading state nobody ever saw. Now a cache hit derives and patches in
      // the tap's own frame, and only a genuine miss shows a loader.
      if (this._filters.scope === "mine" && this._paintMineFromCache()) {
        // Let SWR revalidate behind the paint; re-derive only if it returns a
        // different shelf object.
        window.Collection.shelf(this._shelfTarget(), "owned")
          .then((shelf) => {
            if (seq !== this._loadSeq || !this._mounted) return;
            if (shelf !== this._sortedSrc) { this._deriveMine(shelf); this.render(); }
          })
          .catch(() => {});
        return;
      }

      this._loading = true;
      this._error = null;
      this.render();
      try {
        if (this._filters.scope === "mine") await this._loadMine(seq);
        else await this._loadAll(seq);
      } catch (e) {
        if (seq !== this._loadSeq) return;
        this._error = e.message || "Failed to load games";
        this._games = [];
        this._total = 0;
      } finally {
        if (seq === this._loadSeq) {
          this._loading = false;
          this.render();
        }
      }
    }

    _shelfTarget() {
      const me = window.store.get("user");
      return (me && me.id) || "me";
    }

    /**
     * Synchronous peek at the cached owned shelf. Returns true when it painted.
     */
    _paintMineFromCache() {
      if (!window.Collection.cachedShelf) return false;
      const shelf = window.Collection.cachedShelf(this._shelfTarget(), "owned");
      if (!shelf || !Array.isArray(shelf.items)) return false;
      if (this._serverFallback(shelf)) return false;
      this._loading = false;
      this._error = null;
      this._deriveMine(shelf);
      this.render();
      return true;
    }

    /**
     * A shelf past the endpoint's row cap only needs the server when the user
     * is actually NARROWING it — searching an incomplete copy would miss games,
     * but an unfiltered browse of the prefix is fine. Mirrors
     * ShelfController.serverFallback; this view previously diverted on
     * `truncated` alone, so a >1000-game collection hit the network on every
     * tap even with no filters set.
     */
    _serverFallback(shelf) {
      return !!(shelf && shelf.truncated && this._activeFilterCount() > 0);
    }

    /**
     * Sort ONCE per shelf, not once per tap. Filtering only removes rows, so
     * the added_at order is filter-independent — re-sorting on every chip tap
     * was pure waste, and over a 1000-row shelf with localeCompare (ICU
     * collation, one of the slowest comparators in JS) it was measurable.
     * These are ISO-8601 strings, so a plain relational compare is
     * byte-identical and far cheaper. game_id breaks ties so paging is stable.
     */
    _sortedShelf(shelf) {
      if (this._sortedSrc === shelf) return this._sorted;
      const arr = shelf.items.slice();
      arr.sort((a, b) => {
        const x = a.added_at || "", y = b.added_at || "";
        if (x !== y) return x < y ? 1 : -1;
        const i = a.game_id || "", j = b.game_id || "";
        return i < j ? 1 : i > j ? -1 : 0;
      });
      this._sortedSrc = shelf;
      this._sorted = arr;
      return arr;
    }

    /** Filter + page the cached shelf into _games / _total. No I/O. */
    _deriveMine(shelf) {
      const filtered = window.ShelfFilter.filterShelf(
        this._sortedShelf(shelf), this._filterSpec(),
      );
      const paged = window.ShelfFilter.pageOf(filtered, this._page, PER_PAGE);
      this._page = paged.page;
      this._games = paged.rows.map((it) => it.game);
      this._total = paged.total;
    }

    async _loadMine(seq) {
      const shelf = await window.Collection.shelf(this._shelfTarget(), "owned");
      if (seq !== this._loadSeq) return;

      if (this._serverFallback(shelf)) {
        await this._loadMineFromServer(seq);
        return;
      }

      this._deriveMine(shelf);

      // Auto-switch to the catalog when the user owns nothing matching — only
      // on an unfiltered first load, so the two scopes can't ping-pong.
      if (this._total === 0 && !this._scopeAutoSwitched && this._activeFilterCount() === 0) {
        this._scopeAutoSwitched = true;
        this._filters.scope = "all";
        await this._loadGames();
      }
    }

    /** Server-paged fallback, only for shelves past the endpoint's row cap. */
    async _loadMineFromServer(seq) {
      const qs = this._queryString() + "&status=owned&sort=added_at";
      const data = await window.api.get("/collection/grid?" + qs);
      if (seq !== this._loadSeq) return;
      this._games = (data && data.items ? data.items.map((it) => it.game) : []);
      this._total = (data && data.total) || 0;
    }

    async _loadAll(seq) {
      const qs = this._queryString();
      // The catalog is viewer-independent and changes only on import, so a
      // short window makes page-back and filter-toggle-back free.
      const data = await window.bgbCache.swr(
        CATALOG_NS,
        qs,
        () => window.api.get("/games?" + qs),
        { freshTtl: CATALOG_FRESH_TTL_MS, staleTtl: CATALOG_STALE_TTL_MS },
      );
      if (seq !== this._loadSeq) return;
      this._games = (data && data.games) || [];
      this._total = (data && data.total) || 0;
      this._prefetchNextCatalogPage();
    }

    /**
     * Warm page N+1 behind the current paint so Next is usually a cache hit.
     * Fire-and-forget: the user may never tap Next, and a failure here must
     * never surface.
     */
    _prefetchNextCatalogPage() {
      const totalPages = Math.max(1, Math.ceil(this._total / PER_PAGE));
      if (this._page >= totalPages) return;
      const qs = this._queryString({ page: this._page + 1 });
      window.bgbCache.swr(
        CATALOG_NS,
        qs,
        () => window.api.get("/games?" + qs),
        { freshTtl: CATALOG_FRESH_TTL_MS, staleTtl: CATALOG_STALE_TTL_MS },
      ).catch(() => {});
    }

    _activeFilterCount() {
      const f = this._filters;
      let n = 0;
      if (f.players) n++;
      if (f.playtimeMin != null || f.playtimeMax != null) n++;
      if (f.playMode) n++;
      return n;
    }

    /**
     * Ensure the shell exists, then patch. Nothing in the shell outside the
     * patched regions is state-dependent — the chips are a fixed set whose
     * only variable is an `is-active` class, and every grid state (loading /
     * error / empty / cards) lives inside the grid host — so unlike
     * collection-view this needs no structural signature. The host check is
     * what makes first paint and any accidental teardown self-heal.
     */
    render() {
      if (!this.container.querySelector("#gx-grid-host")) {
        this._renderShell();
        return;
      }
      this._paintChips();
      this._paintGrid();
      this._paintPager();
    }

    _renderShell() {
      this.container.innerHTML = `
        <header class="cascade-back-row">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('log-play')">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h1 class="font-display cascade-back-row__title">Game Explorer</h1>
          <span></span>
        </header>

        <section class="lp-find-section">
          ${this._renderFilters()}
          <div id="gx-grid-host">${this._renderGrid()}</div>
          <div id="gx-pager-host">${this._renderPager()}</div>
        </section>
      `;
      this.refreshIcons();
    }

    /**
     * Chip state, in place. The chip set is fixed, so this only ever toggles a
     * class — no node is replaced. That matters more than the microseconds
     * saved: re-emitting the row destroyed the button under the user's finger
     * mid-gesture, so `:active` never painted and the tap read as ignored, and
     * it reset the horizontally-scrolling .lp-chip-row back to scrollLeft 0.
     */
    _paintChips() {
      const f = this._filters;
      const setActive = (el, on) => {
        if (!el) return;
        el.classList.toggle("is-active", !!on);
        if (el.hasAttribute("aria-selected")) el.setAttribute("aria-selected", String(!!on));
      };
      for (const el of this.container.querySelectorAll("[data-gx-scope]")) {
        setActive(el, el.getAttribute("data-gx-scope") === f.scope);
      }
      for (const el of this.container.querySelectorAll("[data-gx-players]")) {
        setActive(el, f.players === Number(el.getAttribute("data-gx-players")));
      }
      for (const el of this.container.querySelectorAll("[data-gx-bucket]")) {
        const b = PLAYTIME_BUCKETS.find((x) => x.id === el.getAttribute("data-gx-bucket"));
        setActive(el, !!b && isActiveBucket(b, f));
      }
      for (const el of this.container.querySelectorAll("[data-gx-mode]")) {
        setActive(el, f.playMode === el.getAttribute("data-gx-mode"));
      }
    }

    /**
     * Reconcile the grid by game id rather than rewriting it. Cards still on
     * screen keep their existing DOM — crucially their <img>, which otherwise
     * blanks for a frame on every rebuild — and skip the per-card icon
     * hydration. Only genuinely new cards are built.
     */
    _paintGrid() {
      const host = this.container.querySelector("#gx-grid-host");
      if (!host) { this._renderShell(); return; }
      const grid = host.querySelector(".lp-find-grid");

      // Loading / error / empty states aren't a card grid — plain swap.
      if (!grid || this._error || this._games.length === 0) {
        host.innerHTML = this._renderGrid();
        this.refreshIcons(host);
        return;
      }

      const existing = new Map();
      for (const el of grid.children) {
        const id = el.getAttribute("data-game-id");
        if (id) existing.set(id, el);
      }

      const frag = document.createDocumentFragment();
      let builtAny = false;
      for (const g of this._games) {
        let el = existing.get(g.id);
        if (el) {
          existing.delete(g.id);
          this._syncCardStatus(el, g);
        } else {
          const tmp = document.createElement("div");
          tmp.innerHTML = this._cardHtml(g);
          el = tmp.firstElementChild;
          builtAny = true;
        }
        // Appending a node already in the DOM MOVES it, preserving its
        // <img> and any decoded image data.
        if (el) frag.appendChild(el);
      }
      for (const stale of existing.values()) stale.remove();
      grid.appendChild(frag);
      grid.classList.toggle("is-reloading", !!this._loading);
      if (builtAny) this.refreshIcons(grid);
    }

    _cardHtml(g) {
      return window.renderGamePolaroid(g, {
        clickHandler: `window.gameExplorerView._pickFromGrid('${jsStr(g.id)}')`,
        collectionStatus: this._collectionMap[g.id] || null,
        // One viewport of cards, so don't defer them behind lazy-loading.
        eager: true,
      });
    }

    /** Repaint one card's status chip only when it actually changed. The diff
     *  guard and the repaint both live in ui/game-card.js now — same writer as
     *  the initial paint and as the feed's. */
    _syncCardStatus(el, g) {
      window.syncGamePolaroidStatus(el, this._collectionMap[g.id] || null);
    }

    /** Refresh the status pill on every visible card that changed. */
    _paintCardStatuses() {
      const grid = this.container.querySelector(".lp-find-grid");
      if (!grid) return;
      for (const g of this._games) this._syncCardById(grid, g);
    }

    _syncCardById(grid, g) {
      const el = grid.querySelector(`[data-game-id="${window.CSS && window.CSS.escape ? window.CSS.escape(g.id) : g.id}"]`);
      if (el) this._syncCardStatus(el, g);
    }

    _paintPager() {
      const host = this.container.querySelector("#gx-pager-host");
      if (!host) return;
      const next = this._renderPager();
      // The pager is unchanged on most paints; skip the DOM write and the
      // two chevron hydrations when the markup is identical.
      if (host.innerHTML.trim() === next.trim()) return;
      host.innerHTML = next;
      this.refreshIcons(host);
    }

    _renderFilters() {
      const f = this._filters;
      // The onclick strings are deliberately state-INDEPENDENT: the handlers
      // toggle. That is what lets _paintChips() update these buttons by class
      // alone instead of re-emitting them (a value-encoding onclick would go
      // stale the moment the class changed without the markup).
      const playerChip = (n) => `
        <button class="lp-chip ${f.players === n ? "is-active" : ""}" data-gx-players="${n}"
                onclick="window.gameExplorerView._setFilter('players', ${n})">
          ${n === 7 ? "7+" : n}
        </button>`;
      const modeChip = (mode, label) => `
        <button class="lp-chip ${f.playMode === mode ? "is-active" : ""}" data-gx-mode="${mode}"
                onclick="window.gameExplorerView._setFilter('playMode', '${mode}')">
          ${label}
        </button>`;
      return `
        <div class="lp-filters">
          <div class="lp-scope-toggle" role="tablist" aria-label="Game source">
            <button class="lp-scope-toggle__opt ${f.scope === "mine" ? "is-active" : ""}"
                    role="tab" aria-selected="${f.scope === "mine"}" data-gx-scope="mine"
                    onclick="window.gameExplorerView._setScope('mine')">
              My Collection
            </button>
            <button class="lp-scope-toggle__opt ${f.scope === "all" ? "is-active" : ""}"
                    role="tab" aria-selected="${f.scope === "all"}" data-gx-scope="all"
                    onclick="window.gameExplorerView._setScope('all')">
              All BgB Games
            </button>
          </div>
          <div class="lp-filter-row">
            <span class="lp-filter-label">Players</span>
            <div class="lp-chip-row">
              ${[1, 2, 3, 4, 5, 6, 7].map(playerChip).join("")}
            </div>
          </div>
          <div class="lp-filter-row">
            <span class="lp-filter-label">Play time</span>
            <div class="lp-chip-row">
              ${PLAYTIME_BUCKETS.map((b) => `
                <button class="lp-chip ${isActiveBucket(b, f) ? "is-active" : ""}" data-gx-bucket="${b.id}"
                        onclick="window.gameExplorerView._setPlaytimeBucket('${b.id}')">
                  ${b.label}
                </button>`).join("")}
            </div>
          </div>
          <div class="lp-filter-row">
            <span class="lp-filter-label">Type</span>
            <div class="lp-chip-row">
              ${modeChip("competitive", "Competitive")}
              ${modeChip("coop", "Co-op")}
              ${modeChip("team", "Team")}
            </div>
          </div>
        </div>
      `;
    }

    _renderGrid() {
      if (this._error) {
        return `<div class="alert alert-error">${escapeHtml(this._error)}</div>`;
      }
      if (this._loading && this._games.length === 0) {
        return `<div class="lp-find-loading">${window.buddyLoader({ size: 72 })}</div>`;
      }
      if (this._games.length === 0) {
        const inCollection = this._filters.scope === "mine";
        return `
          <div class="lp-find-empty">
            <p>${inCollection
              ? "No games in your collection match these filters."
              : "No games match these filters."}</p>
            ${this._activeFilterCount() > 0
              ? `<button class="btn btn-ghost btn-sm" onclick="window.gameExplorerView._clearFilters()">
                   Clear filters
                 </button>`
              : ""}
          </div>
        `;
      }
      const cards = this._games.map((g) => window.renderGamePolaroid(g, {
        clickHandler: `window.gameExplorerView._pickFromGrid('${jsStr(g.id)}')`,
        collectionStatus: this._collectionMap[g.id] || null,
      })).join("");
      return `<div class="lp-find-grid ${this._loading ? "is-reloading" : ""}">${cards}</div>`;
    }

    _renderPager() {
      const totalPages = Math.max(1, Math.ceil(this._total / PER_PAGE));
      if (totalPages <= 1) return "";
      return `
        <nav class="lp-find-pager">
          <button class="btn btn-ghost btn-sm" ${this._page <= 1 ? "disabled" : ""}
                  onclick="window.gameExplorerView._goPage(${this._page - 1})">
            <i data-icon="chevron-left" class="w-4 h-4"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._page} of ${totalPages}</span>
          <button class="btn btn-ghost btn-sm" ${this._page >= totalPages ? "disabled" : ""}
                  onclick="window.gameExplorerView._goPage(${this._page + 1})">
            Next <i data-icon="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    // ── Filter actions ───────────────────────────────────────────────────────

    _setScope(scope) {
      if (this._filters.scope === scope) return;
      this._filters.scope = scope;
      this._page = 1;
      // Manual scope switch overrides the empty-collection auto-fallback.
      this._scopeAutoSwitched = true;
      this._loadGames();
    }

    // Toggles: tapping the active chip clears it. The chip markup no longer
    // encodes which of those two a tap means, so the decision lives here.
    _setFilter(key, value) {
      this._filters[key] = this._filters[key] === value ? null : value;
      this._page = 1;
      this._loadGames();
    }

    _setPlaytimeBucket(id) {
      const f = this._filters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = cur && cur.id === id ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._page = 1;
      this._loadGames();
    }

    _clearFilters() {
      const scope = this._filters.scope;
      this._filters = this._emptyFilters();
      this._filters.scope = scope;
      this._page = 1;
      this._loadGames();
    }

    _goPage(n) {
      this._page = n;
      // Scroll AFTER the paint. Previously this queried the DOM the render
      // had just replaced and then animated a smooth scroll concurrently with
      // a full container rebuild — scroll animation plus re-layout is the
      // classic jank pairing.
      Promise.resolve(this._loadGames()).then(() => {
        const el = this.container.querySelector(".lp-find-section");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    // ── Pick ─────────────────────────────────────────────────────────────────

    // Stages the game into the active draft and drops the user on Gather with
    // it prefilled. Same staging contract as the Play tab's Another Round:
    // PlayFlowView.onMount() reads PlaySession.load() from localStorage, so
    // persist() before navigating.
    _pickFromGrid(gameId) {
      const g = this._games.find((x) => x.id === gameId);
      if (!g) return;
      const ps = window.store.get("activePlay") || new window.PlaySession();
      ps.gameId = g.id;
      ps.gameSnapshot = {
        id: g.id,
        name: g.name,
        thumbnail_url: g.thumbnail_url,
        rulebook_url: g.rulebook_url,
        is_expansion: !!g.is_expansion,
      };
      ps.playMode = g.play_mode || ps.playMode || null;
      ps.persist();
      window.store.set("activePlay", ps);
      // Warm the reference-guide cache in the background so the guide is
      // instant once the host lands on the Play screen (or opens game detail).
      window.Chapter.prefetchMyChapters(g.id);
      // If a lobby is already open (e.g. the user came here mid-session to
      // swap games), push the swap to the server so joiners see it. Otherwise
      // start minting one now — see LogPlayView._host() for why the two cases
      // must stay exclusive.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: g.id }).catch(() => {});
      } else {
        window.PlaySession.prefetchLobby({ gameId: g.id });
      }
      window.router.go("play-flow");
    }
  }

  window.GameExplorerView = GameExplorerView;
})();
