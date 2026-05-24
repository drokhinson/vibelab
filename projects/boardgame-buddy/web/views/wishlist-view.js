// views/wishlist-view.js — Full wishlist spoke.
//
// Mirrors collection-view but pins status='wishlist' and drops the toggle.
// "+ Add" button in the header opens the AddGameModal for searching the
// BgB library or importing from BGG.

(function () {
  const PER_PAGE = 12;

  const PLAYTIME_BUCKETS = [
    { id: "u30",   label: "< 30 min",   min: null, max: 29 },
    { id: "30-60", label: "30–60 min",  min: 30,   max: 60 },
    { id: "60-90", label: "60–90 min",  min: 60,   max: 90 },
    { id: "90-120",label: "90–120 min", min: 90,   max: 120 },
    { id: "o120",  label: "2+ hours",   min: 120,  max: null },
  ];
  function isActiveBucket(b, f) {
    return f.playtimeMin === b.min && f.playtimeMax === b.max;
  }

  class WishlistView extends window.View {
    constructor() {
      super("wishlist");
      this._items = [];
      this._total = 0;
      this._page = 1;
      this._loading = false;
      this._error = null;
      this._query = "";
      this._filters = { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
      this._filtersOpen = false;
      this._searchTimer = null;
      this._statusMap = {};
      this._expansionCounts = {};
    }

    async onMount() {
      this.listen("user", () => this.render());
      this.listen("myCollectionMap", () => this._refreshMaps());
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this.render();
      });
      const seed = window.store.get("profileBundle");
      if (seed) {
        this._items = seed.wishlist_page || [];
        this._total = seed.wishlist_total || 0;
        this._statusMap = seed.status_map || {};
        this._expansionCounts = seed.expansion_counts || {};
      } else {
        this._loading = true;
      }
      this.render();
      await Promise.all([this._load(), this._refreshMaps()]);
    }

    renderLoading() {
      this.container.innerHTML = `
        ${this._renderHead()}
        <div class="p-4 grid place-items-center">${window.buddyLoader({ size: 64 })}</div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    render() {
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      const totalPages = Math.max(1, Math.ceil(this._total / PER_PAGE));
      const hasPager = totalPages > 1;
      this.container.innerHTML = `
        ${this._renderHead()}
        ${this._renderControls()}
        ${this._filtersOpen ? this._renderFilters() : ""}
        ${this._renderBody(hasPager)}
        ${this._renderPager()}
      `;
      if (window.lucide) window.lucide.createIcons();

      if (activeId) {
        const el = document.getElementById(activeId);
        if (el && el.focus) {
          el.focus();
          if (caret != null && el.setSelectionRange) {
            try { el.setSelectionRange(caret, caret); } catch (_) {}
          }
        }
      }
    }

    _renderHead() {
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" onclick="window.router.go('profile-self')" aria-label="Back to profile">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">Wishlist</h2>
          <span class="spoke-head__count">${this._total} game${this._total === 1 ? "" : "s"}</span>
          <button class="spoke-head__add btn btn-primary btn-sm"
                  onclick="window.wishlistView._openAddGame()"
                  aria-label="Add a game to your wishlist">
            <i data-lucide="plus" class="w-4 h-4"></i><span>Add</span>
          </button>
        </header>
      `;
    }

    _openAddGame() {
      window.AddGameModal.open({
        status: "wishlist",
        onAdded: () => { this._load(); },
      });
    }

    _renderControls() {
      const activeFilters = this._activeFilterCount();
      return `
        <div class="profile-panel__controls">
          <input id="wishlist-search-input"
                 class="input input-bordered flex-1 min-w-0"
                 placeholder="Search your wishlist by name"
                 autocomplete="off"
                 value="${escapeAttr(this._query)}"
                 oninput="window.wishlistView._onSearchInput(this.value)" />
          <button class="btn btn-ghost relative" title="Filters"
                  onclick="window.wishlistView._toggleFilters()">
            <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>
            ${activeFilters > 0 ? `<span class="search-filter-badge">${activeFilters}</span>` : ""}
          </button>
        </div>
      `;
    }

    _renderFilters() {
      const f = this._filters;
      const playerChip = (n) => `
        <button class="filter-chip ${f.players === n ? "is-active" : ""}"
                onclick="window.wishlistView._setFilter('players', ${f.players === n ? "null" : n})">
          ${n === 7 ? "7+" : n}
        </button>
      `;
      const modeChip = (mode, label) => `
        <button class="filter-chip ${f.playMode === mode ? "is-active" : ""}"
                onclick="window.wishlistView._setFilter('playMode', ${f.playMode === mode ? "null" : "'" + mode + "'"})">
          ${label}
        </button>
      `;
      return `
        <section class="search-filters">
          <div class="search-filter-group">
            <label class="search-filter-label">Players</label>
            <div class="filter-chip-row">${[1,2,3,4,5,6,7].map(playerChip).join("")}</div>
          </div>
          <div class="search-filter-group">
            <label class="search-filter-label">Playtime (min)</label>
            <div class="filter-chip-row">
              ${PLAYTIME_BUCKETS.map((b) => `
                <button class="filter-chip ${isActiveBucket(b, f) ? "is-active" : ""}"
                        onclick="window.wishlistView._setPlaytimeBucket('${b.id}')">
                  ${b.label}
                </button>
              `).join("")}
            </div>
          </div>
          <div class="search-filter-group">
            <label class="search-filter-label">Play mode</label>
            <div class="filter-chip-row">
              ${modeChip("competitive", "Competitive")}
              ${modeChip("coop", "Cooperative")}
              ${modeChip("team", "Teams")}
            </div>
          </div>
          ${this._activeFilterCount() > 0
            ? `<div class="search-filters__footer">
                <button class="btn btn-ghost btn-xs" onclick="window.wishlistView._clearFilters()">Clear filters</button>
              </div>`
            : ""}
        </section>
      `;
    }

    _renderBody(hasPager = false) {
      if (this._error) {
        return `<div class="alert alert-error text-sm">${escape(this._error)}</div>`;
      }
      if (this._loading && this._items.length === 0) {
        return window.buddyLoader({ size: 88 });
      }
      if (this._items.length === 0) {
        const isSearchingOrFiltering = this._query || this._activeFilterCount() > 0;
        return `<div class="profile-empty">${isSearchingOrFiltering ? "No wishlist matches." : "Wishlist is empty — tap the + Add button to add a game."}</div>`;
      }
      const reloading = this._loading ? "is-reloading" : "";
      const paginated = hasPager ? "is-paginated" : "";
      return `
        <div class="profile-collection-grid ${reloading} ${paginated}">
          ${this._items.map((it) => this._renderTile(it)).join("")}
        </div>
      `;
    }

    _renderTile(item) {
      const g = item.game || {};
      const status = this._statusMap[g.id] || item.status || null;
      const expCount = g.bgg_id ? (this._expansionCounts[g.bgg_id] || 0) : 0;
      return `
        <div class="collection-tile" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || "")}'})">
          ${window.renderStatusTag(g.id, status, { size: "xs" })}
          ${g.thumbnail_url
            ? `<img src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" />`
            : `<div class="collection-tile__placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="collection-tile__name">${escape(g.name || "Unknown")}</div>
          ${window.renderExpansionBadge(expCount)}
        </div>
      `;
    }

    _renderPager() {
      const totalPages = Math.max(1, Math.ceil(this._total / PER_PAGE));
      if (totalPages <= 1) return "";
      return `
        <nav class="spoke-pager-footer" aria-label="Wishlist pagination">
          <button class="btn btn-primary spoke-pager-footer__btn" ${this._page <= 1 ? "disabled" : ""}
                  onclick="window.wishlistView._goPage(${this._page - 1})"
                  aria-label="Previous page">
            <i data-lucide="chevron-left" class="w-4 h-4"></i><span>Prev</span>
          </button>
          <span class="spoke-pager-footer__page">Page ${this._page} of ${totalPages}</span>
          <button class="btn btn-primary spoke-pager-footer__btn" ${this._page >= totalPages ? "disabled" : ""}
                  onclick="window.wishlistView._goPage(${this._page + 1})"
                  aria-label="Next page">
            <span>Next</span><i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    _buildQuery() {
      const qs = new URLSearchParams({
        status: "wishlist",
        page: String(this._page),
        per_page: String(PER_PAGE),
        exclude_expansions: "true",
      });
      if (this._query) qs.set("search", this._query);
      const f = this._filters;
      if (f.players) qs.set("players", String(f.players));
      if (f.playtimeMin != null) qs.set("playtime_min", String(f.playtimeMin));
      if (f.playtimeMax != null) qs.set("playtime_max", String(f.playtimeMax));
      if (f.playMode) qs.set("play_mode", f.playMode);
      return qs.toString();
    }

    async _load() {
      this._loading = true;
      this._error = null;
      this.render();
      try {
        const data = await window.api.get("/collection/grid?" + this._buildQuery());
        this._items = (data && data.items) || [];
        this._total = (data && data.total) || 0;
      } catch (e) {
        this._error = e.message || "Failed to load";
        this._items = [];
        this._total = 0;
      } finally {
        this._loading = false;
        this.render();
      }
    }

    async _refreshMaps() {
      try {
        const [status, exp] = await Promise.all([
          window.Collection.myStatusMap(),
          window.Collection.myExpansionCountByBaseBggId(),
        ]);
        this._statusMap = status || {};
        this._expansionCounts = exp || {};
      } catch (_) {}
      this.render();
    }

    _onSearchInput(value) {
      this._query = value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => { this._page = 1; this._load(); }, 300);
    }
    _setFilter(key, value) {
      this._filters[key] = value;
      this._page = 1;
      this._load();
    }
    _clearFilters() {
      this._filters = { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
      this._page = 1;
      this._load();
    }
    _setPlaytimeBucket(id) {
      const f = this._filters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = (cur && cur.id === id) ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._page = 1;
      this._load();
    }
    _toggleFilters() { this._filtersOpen = !this._filtersOpen; this.render(); }
    _activeFilterCount() {
      const f = this._filters;
      let n = 0;
      if (f.players) n++;
      if (f.playtimeMin != null || f.playtimeMax != null) n++;
      if (f.playMode) n++;
      return n;
    }
    _goPage(n) { this._page = n; this._load(); }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.WishlistView = WishlistView;
})();
