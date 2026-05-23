// views/collection-view.js — Full collection spoke.
//
// Toggle between "Owned" and "Played, not owned" + shared search/filters.
// Wishlist lives at its own /wishlist route. The "+ Game" FAB is rendered
// here so it's only visible on Collection + Wishlist.

(function () {
  const PER_PAGE = 12;
  const MODE_OWNED = "owned";
  const MODE_PLAYED = "played";

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

  class CollectionView extends window.View {
    constructor() {
      super("collection");
      this._resetState();
    }

    _resetState() {
      this._mode = MODE_OWNED;
      this._items = { owned: [], played: [] };
      this._total = { owned: 0, played: 0 };
      this._page = { owned: 1, played: 1 };
      this._loading = { owned: false, played: false };
      this._error = { owned: null, played: null };
      this._query = "";
      this._filters = { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
      this._filtersOpen = false;
      this._searchTimer = null;
      this._statusMap = {};
      this._expansionCounts = {};
      this._targetUserId = null;
      this._targetProfile = null;
    }

    _isOther() {
      const me = window.store.get("user");
      return !!(this._targetUserId && me && this._targetUserId !== me.id);
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
      await this._initFromParams();
    }

    async onParamsChange() {
      await this._initFromParams();
    }

    async _initFromParams() {
      // The view instance is a singleton across mounts (init.js wires it
      // once). Reset before reading params so user A's items don't linger
      // on screen while user B's fetch is in flight.
      this._resetState();
      this._targetUserId = (this.params && this.params.userId) || null;
      if (this._isOther()) {
        // Fetch the target user's display name for the header. Their
        // collection grid is loaded by _loadMode below; only the owned
        // tab is exercised when viewing someone else (no played-not-owned
        // surface on the public view).
        this.render();
        window.User.fetch(this._targetUserId)
          .then((p) => { this._targetProfile = p; this.render(); })
          .catch(() => {});
        this._loading.owned = true;
        await this._loadMode(MODE_OWNED);
        // Viewer maps still apply — overlay "you own this" pills on
        // the other user's tiles.
        await this._refreshMaps();
        return;
      }
      // Self path — seed from the profile bundle the hub pre-fetched.
      const seed = window.store.get("profileBundle");
      if (seed) {
        this._items.owned = seed.owned_page || [];
        this._total.owned = seed.owned_total || 0;
        this._items.played = seed.played_page || [];
        this._total.played = seed.played_total || 0;
        this._statusMap = seed.status_map || {};
        this._expansionCounts = seed.expansion_counts || {};
      } else {
        this._loading.owned = true;
        this._loading.played = true;
      }
      this.render();
      await Promise.all([
        this._loadMode(MODE_OWNED),
        this._loadMode(MODE_PLAYED),
        this._refreshMaps(),
      ]);
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

      // Cold load — no seed from the profile bundle and both lists are
      // empty + fetching. Show only the header + bgb logo loader instead
      // of flashing the controls, toggle, and empty body underneath.
      const coldLoad = this._loading.owned && this._loading.played
        && (this._items.owned || []).length === 0
        && (this._items.played || []).length === 0;
      if (coldLoad) {
        this.container.innerHTML = `
          ${this._renderHead()}
          <div class="profile-loading">
            ${window.buddyLoader({ size: 96, label: "Loading collection…" })}
          </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      const other = this._isOther();
      this.container.innerHTML = `
        ${this._renderHead()}
        ${other ? "" : this._renderControls()}
        ${other ? "" : this._renderToggle()}
        ${!other && this._filtersOpen ? this._renderFilters() : ""}
        ${this._renderBody()}
        ${this._renderPager()}
        ${other ? "" : this._renderFab()}
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
      const total = this._total[this._mode];
      const other = this._isOther();
      const backJs = other
        ? `window.router.go('profile-other',{userId:'${escapeAttr(this._targetUserId)}'})`
        : "window.router.go('profile-self')";
      const name = this._targetProfile && this._targetProfile.display_name;
      const title = other
        ? (name ? `${escape(name)}'s collection` : "Collection")
        : "Collection";
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" onclick="${backJs}" aria-label="Back to profile">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">${title}</h2>
          <span class="spoke-head__count">${total} game${total === 1 ? "" : "s"}</span>
        </header>
      `;
    }

    _renderControls() {
      const activeFilters = this._activeFilterCount();
      return `
        <div class="profile-panel__controls">
          <input id="collection-search-input"
                 class="input input-bordered flex-1 min-w-0"
                 placeholder="Search your collection by name"
                 autocomplete="off"
                 value="${escapeAttr(this._query)}"
                 oninput="window.collectionView._onSearchInput(this.value)" />
          <button class="btn btn-ghost relative" title="Filters"
                  onclick="window.collectionView._toggleFilters()">
            <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>
            ${activeFilters > 0 ? `<span class="search-filter-badge">${activeFilters}</span>` : ""}
          </button>
        </div>
      `;
    }

    _renderToggle() {
      const ownedActive = this._mode === MODE_OWNED ? "is-active" : "";
      const playedActive = this._mode === MODE_PLAYED ? "is-active" : "";
      return `
        <div class="spoke-toggle" role="tablist">
          <button class="spoke-toggle__pill ${ownedActive}"
                  role="tab" aria-selected="${this._mode === MODE_OWNED}"
                  onclick="window.collectionView._setMode('${MODE_OWNED}')">
            Owned <span class="spoke-toggle__count">${this._total.owned}</span>
          </button>
          <button class="spoke-toggle__pill ${playedActive}"
                  role="tab" aria-selected="${this._mode === MODE_PLAYED}"
                  onclick="window.collectionView._setMode('${MODE_PLAYED}')">
            Played, not owned <span class="spoke-toggle__count">${this._total.played}</span>
          </button>
        </div>
      `;
    }

    _renderFilters() {
      const f = this._filters;
      const playerChip = (n) => `
        <button class="filter-chip ${f.players === n ? "is-active" : ""}"
                onclick="window.collectionView._setFilter('players', ${f.players === n ? "null" : n})">
          ${n === 7 ? "7+" : n}
        </button>
      `;
      const modeChip = (mode, label) => `
        <button class="filter-chip ${f.playMode === mode ? "is-active" : ""}"
                onclick="window.collectionView._setFilter('playMode', ${f.playMode === mode ? "null" : "'" + mode + "'"})">
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
                        onclick="window.collectionView._setPlaytimeBucket('${b.id}')">
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
                <button class="btn btn-ghost btn-xs" onclick="window.collectionView._clearFilters()">Clear filters</button>
              </div>`
            : ""}
        </section>
      `;
    }

    _renderBody() {
      const mode = this._mode;
      if (this._error[mode]) {
        return `<div class="alert alert-error text-sm">${escape(this._error[mode])}</div>`;
      }
      const items = this._items[mode] || [];
      if (this._loading[mode] && items.length === 0) {
        return `<div class="profile-loading">${window.buddyLoader({ size: 88, label: "Loading collection…" })}</div>`;
      }
      if (items.length === 0) {
        const isSearchingOrFiltering = this._query || this._activeFilterCount() > 0;
        let empty;
        if (this._isOther()) {
          const who = (this._targetProfile && this._targetProfile.display_name) || "They";
          empty = `${who} doesn't own any games yet.`;
        } else if (mode === MODE_OWNED) {
          empty = isSearchingOrFiltering ? "No matches in your collection." : "No owned games yet — tap the + to add one.";
        } else {
          empty = isSearchingOrFiltering ? "No played-not-owned matches." : "No played-but-uncollected games.";
        }
        return `<div class="profile-empty">${escape(empty)}</div>`;
      }
      const reloading = this._loading[mode] ? "is-reloading" : "";
      return `
        <div class="profile-collection-grid ${reloading}">
          ${items.map((it) => this._renderTile(it)).join("")}
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
      const total = this._total[this._mode];
      const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
      if (totalPages <= 1) return "";
      const page = this._page[this._mode];
      return `
        <nav class="search-pager">
          <button class="btn btn-ghost btn-xs" ${page <= 1 ? "disabled" : ""}
                  onclick="window.collectionView._goPage(${page - 1})">
            <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${page} of ${totalPages}</span>
          <button class="btn btn-ghost btn-xs" ${page >= totalPages ? "disabled" : ""}
                  onclick="window.collectionView._goPage(${page + 1})">
            Next <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </button>
        </nav>
      `;
    }

    _renderFab() {
      return `
        <button class="fab-add-game" onclick="window.router.go('log-play', { focus: 'find' })"
                aria-label="Add a game to your collection">
          <i data-lucide="plus" class="w-4 h-4"></i>
          <span>Game</span>
        </button>
      `;
    }

    // ── Loaders ───────────────────────────────────────────────────────────────
    _buildQuery({ status, page }) {
      const qs = new URLSearchParams({
        status,
        page: String(page),
        per_page: String(PER_PAGE),
        exclude_expansions: "true",
      });
      if (this._isOther()) qs.set("user_id", this._targetUserId);
      if (this._query) qs.set("search", this._query);
      const f = this._filters;
      if (f.players) qs.set("players", String(f.players));
      if (f.playtimeMin != null) qs.set("playtime_min", String(f.playtimeMin));
      if (f.playtimeMax != null) qs.set("playtime_max", String(f.playtimeMax));
      if (f.playMode) qs.set("play_mode", f.playMode);
      return qs.toString();
    }

    async _loadMode(mode) {
      this._loading[mode] = true;
      this._error[mode] = null;
      this.render();
      try {
        const qs = this._buildQuery({ status: mode, page: this._page[mode] });
        const data = await window.api.get("/collection/grid?" + qs);
        this._items[mode] = (data && data.items) || [];
        this._total[mode] = (data && data.total) || 0;
      } catch (e) {
        this._error[mode] = e.message || "Failed to load";
        this._items[mode] = [];
        this._total[mode] = 0;
      } finally {
        this._loading[mode] = false;
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

    // ── Handlers ──────────────────────────────────────────────────────────────
    _setMode(mode) {
      if (this._mode === mode) return;
      this._mode = mode;
      if (this._items[mode].length === 0 && !this._loading[mode]) {
        this._loadMode(mode);
      } else {
        this.render();
      }
    }
    _onSearchInput(value) {
      this._query = value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._reloadBoth(), 300);
    }
    _setFilter(key, value) {
      this._filters[key] = value;
      this._reloadBoth();
    }
    _clearFilters() {
      this._filters = { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
      this._reloadBoth();
    }
    _setPlaytimeBucket(id) {
      const f = this._filters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = (cur && cur.id === id) ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._reloadBoth();
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
    _reloadBoth() {
      // Search/filter changes reset both sides so the toggle never lands
      // on a stale page index.
      this._page.owned = 1;
      this._page.played = 1;
      Promise.all([this._loadMode(MODE_OWNED), this._loadMode(MODE_PLAYED)]);
    }
    _goPage(n) {
      this._page[this._mode] = n;
      this._loadMode(this._mode);
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.CollectionView = CollectionView;
})();
