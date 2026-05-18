// views/profile-self-view.js — three-tab view of the user's stuff.
//
// Tabs (no counts in the labels): Game Collection, Recent Plays, Buddies.
// Display name / BGG link / admin shortcut / logout live on Settings now
// (reachable via the global header avatar).

(function () {
  const PLAYS_PER_PAGE = 10;
  const COLLECTION_PER_PAGE = 12;
  // Wishlist + played-not-owned shelves are intentionally smaller — 2 rows
  // (3-column grid → 6 per page) so they read as secondary shelves below the
  // main owned collection. Search + filter pills apply to all three shelves.
  const WISHLIST_PER_PAGE = 6;
  const PLAYED_PER_PAGE = 6;
  const TAB_COLLECTION = "collection";
  const TAB_PLAYS = "plays";
  const TAB_BUDDIES = "buddies";

  // Same playtime bubbles as the game-search filter panel. Duplicated
  // locally so each view stays self-contained — they're tiny.
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

  class ProfileSelfView extends window.View {
    constructor() {
      super("profile-self");
      this._activeTab = TAB_COLLECTION;
      this._stats = null;
      this._statsError = null;

      // Recent plays
      this._recentPlays = [];
      this._recentPlaysTotal = 0;
      this._recentPlaysPage = 1;
      this._recentPlaysQuery = "";
      this._recentPlaysLoading = false;
      this._recentPlaysError = null;
      this._recentPlaysLoaded = false;
      this._recentSearchTimer = null;

      // Collection (owned)
      this._collectionItems = [];
      this._collectionTotal = 0;
      this._collectionPage = 1;
      this._collectionQuery = "";
      this._collectionFilters = this._emptyCollectionFilters();
      this._collectionFiltersOpen = false;
      this._collectionLoading = false;
      this._collectionError = null;
      this._collectionSearchTimer = null;

      // Wishlist — same search + filters as the owned collection but a
      // separate page cursor and its own loading/error state.
      this._wishlistItems = [];
      this._wishlistTotal = 0;
      this._wishlistPage = 1;
      this._wishlistLoading = false;
      this._wishlistError = null;

      // Played-not-owned — games the user has logged plays for but doesn't
      // currently own or wishlist. Shares the same shelf-query plumbing.
      this._playedItems = [];
      this._playedTotal = 0;
      this._playedPage = 1;
      this._playedLoading = false;
      this._playedError = null;

      // Buddies tab is delegated to the shared BuddiesPanel — same render
      // logic the standalone /buddies route uses.
      this._buddiesPanel = new window.BuddiesPanel("__profileBuddiesPanel");
    }

    _emptyCollectionFilters() {
      return { players: null, playtimeMin: null, playtimeMax: null, playMode: null };
    }

    async onMount() {
      this.listen("user", () => this.render());
      // Re-render tiles when the viewer's status map changes (a status-tag
      // pick on any tile bumps this); cheap because the cache is in memory.
      this.listen("myCollectionMap", () => this._refreshCollectionData());
      // status-changed bubbles synchronously after a successful status
      // pick — patch in the new entry without waiting for the refetch.
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this.render();
      });

      this._statusMap = {};
      this._expansionCounts = {};
      this.render();
      // Cold-load: one round trip via /profile/bundle covers stats + every
      // shelf's first page + recent plays + the viewer's collection map +
      // expansion counts. Buddies panel keeps its own load path — its
      // played-with and ghost-player blocks aren't in the bundle, and
      // teaching the panel to seed partially would be churn for little win.
      const meId = window.store.get("user").id;
      const bundlePromise = window.Profile.bundle(meId)
        .then((b) => this._hydrateFromBundle(b))
        .catch((e) => {
          // Fall back to the legacy fan-out if the bundle endpoint fails for
          // any reason — keeps Profile usable while a regression is being
          // diagnosed.
          if (window.console) console.warn("profile bundle failed, falling back", e);
          return Promise.all([
            this._loadStats(),
            this._loadCollection({ reset: true }),
            this._refreshCollectionData(),
            this._loadRecentPlays({ reset: true }),
          ]);
        });
      await Promise.all([bundlePromise, this._buddiesPanel._load()]);
    }

    _hydrateFromBundle(b) {
      if (!b) return;
      // Stats.
      this._stats = b.stats || null;
      this._statsError = null;
      // Collection shelves — match the existing /collection/grid shape:
      // { items, total, page, per_page }. Bundle returns *_page (the items
      // array) + *_total alongside it; merge them into the same state slots
      // the per-shelf loaders use so the existing render code keeps working.
      this._collectionItems = b.owned_page || [];
      this._collectionTotal = b.owned_total || 0;
      this._collectionPage = 1;
      this._collectionError = null;
      this._wishlistItems = b.wishlist_page || [];
      this._wishlistTotal = b.wishlist_total || 0;
      this._wishlistPage = 1;
      this._wishlistError = null;
      this._playedItems = b.played_page || [];
      this._playedTotal = b.played_total || 0;
      this._playedPage = 1;
      this._playedError = null;
      // Recent plays.
      this._recentPlays = b.recent_plays || [];
      this._recentPlaysTotal = b.recent_plays_total || 0;
      this._recentPlaysPage = 1;
      this._recentPlaysLoaded = true;
      this._recentPlaysError = null;
      // Status pills + expansion counts.
      this._statusMap = b.status_map || {};
      this._expansionCounts = b.expansion_counts || {};
      window.Collection.seedFromBundle(this._statusMap, this._expansionCounts);
      this.render();
    }

    async _refreshCollectionData() {
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

    async onUnmount() {
      this._buddiesPanel.unmount();
    }

    // ── Loaders ───────────────────────────────────────────────────────────────

    async _loadStats() {
      try {
        this._stats = await window.Stats.for(window.store.get("user").id);
      } catch (e) {
        this._statsError = e.message || "Failed to load stats";
      }
      this.render();
    }

    async _loadRecentPlays({ reset = false } = {}) {
      this._recentPlaysLoading = true;
      this._recentPlaysError = null;
      if (reset) { this._recentPlaysPage = 1; this._recentPlays = []; }
      this.render();
      try {
        const data = await window.Play.list({
          page: this._recentPlaysPage,
          perPage: PLAYS_PER_PAGE,
          search: this._recentPlaysQuery || null,
        });
        const fresh = (data && data.plays) || [];
        this._recentPlaysTotal = (data && data.total) || 0;
        this._recentPlays = reset ? fresh : [...this._recentPlays, ...fresh];
      } catch (e) {
        this._recentPlaysError = e.message || "Failed to load";
      } finally {
        this._recentPlaysLoading = false;
        this._recentPlaysLoaded = true;
        this.render();
      }
    }

    // Builds the shared filter query string. Search input + filter pills
    // apply to both the owned grid and the wishlist — the only per-shelf
    // params are status, page, and per_page.
    _buildShelfQuery({ status, page, perPage }) {
      const qs = new URLSearchParams({
        status,
        page: String(page),
        per_page: String(perPage),
        exclude_expansions: "true",
      });
      if (this._collectionQuery) qs.set("search", this._collectionQuery);
      const f = this._collectionFilters;
      if (f.players)            qs.set("players", String(f.players));
      if (f.playtimeMin != null) qs.set("playtime_min", String(f.playtimeMin));
      if (f.playtimeMax != null) qs.set("playtime_max", String(f.playtimeMax));
      if (f.playMode)           qs.set("play_mode", f.playMode);
      return qs.toString();
    }

    async _loadCollection({ reset = false } = {}) {
      // Reset paging on filter/search changes so the user lands on page 1 of
      // all three shelves, then fetch owned + wishlist + played in parallel
      // — they share the same backend filter inputs so doing it sequentially
      // would just add latency.
      if (reset) {
        this._collectionPage = 1;
        this._wishlistPage = 1;
        this._playedPage = 1;
      }
      await Promise.all([
        this._loadOwned(),
        this._loadWishlist(),
        this._loadPlayed(),
      ]);
    }

    async _loadOwned() {
      this._collectionLoading = true;
      this._collectionError = null;
      this.render();
      try {
        const qs = this._buildShelfQuery({
          status: "owned",
          page: this._collectionPage,
          perPage: COLLECTION_PER_PAGE,
        });
        const data = await window.api.get("/collection/grid?" + qs);
        this._collectionItems = (data && data.items) || [];
        this._collectionTotal = (data && data.total) || 0;
      } catch (e) {
        this._collectionError = e.message || "Failed to load";
        this._collectionItems = [];
        this._collectionTotal = 0;
      } finally {
        this._collectionLoading = false;
        this.render();
      }
    }

    async _loadWishlist() {
      this._wishlistLoading = true;
      this._wishlistError = null;
      this.render();
      try {
        const qs = this._buildShelfQuery({
          status: "wishlist",
          page: this._wishlistPage,
          perPage: WISHLIST_PER_PAGE,
        });
        const data = await window.api.get("/collection/grid?" + qs);
        this._wishlistItems = (data && data.items) || [];
        this._wishlistTotal = (data && data.total) || 0;
      } catch (e) {
        this._wishlistError = e.message || "Failed to load";
        this._wishlistItems = [];
        this._wishlistTotal = 0;
      } finally {
        this._wishlistLoading = false;
        this.render();
      }
    }

    async _loadPlayed() {
      this._playedLoading = true;
      this._playedError = null;
      this.render();
      try {
        const qs = this._buildShelfQuery({
          status: "played",
          page: this._playedPage,
          perPage: PLAYED_PER_PAGE,
        });
        const data = await window.api.get("/collection/grid?" + qs);
        this._playedItems = (data && data.items) || [];
        this._playedTotal = (data && data.total) || 0;
      } catch (e) {
        this._playedError = e.message || "Failed to load";
        this._playedItems = [];
        this._playedTotal = 0;
      } finally {
        this._playedLoading = false;
        this.render();
      }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    render() {
      const me = window.store.get("user");
      if (!me) {
        this.container.innerHTML = `<div class="p-6 text-center">Not signed in.</div>`;
        return;
      }

      // Preserve focus + caret across re-renders so search inputs don't pop
      // the cursor out on every keystroke.
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      const s = this._stats ? window.Stats.format(this._stats) : null;

      this.container.innerHTML = `
        <section class="profile-stats">
          ${s ? this._statRow(s) : window.buddyLoader({ size: 72, label: "Loading stats" })}
        </section>

        <nav class="profile-tabs" role="tablist">
          ${this._renderTab(TAB_COLLECTION, "Game Collection")}
          ${this._renderTab(TAB_PLAYS,      "Recent Plays")}
          ${this._renderTab(TAB_BUDDIES,    "Buddies")}
        </nav>

        <div id="profile-tab-body" class="profile-tab-body"></div>
      `;
      this._renderActiveTab();
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

    _renderTab(id, label) {
      const isActive = this._activeTab === id;
      return `
        <button class="profile-tab ${isActive ? "is-active" : ""}"
                role="tab" aria-selected="${isActive}"
                onclick="window.profileSelfView._switchTab('${id}')">
          ${label}
        </button>
      `;
    }

    _renderActiveTab() {
      const body = document.getElementById("profile-tab-body");
      if (!body) return;
      if (this._activeTab === TAB_COLLECTION) {
        body.innerHTML = this._renderCollectionPanel();
      } else if (this._activeTab === TAB_PLAYS) {
        body.innerHTML = this._renderRecentPlaysPanel();
      } else if (this._activeTab === TAB_BUDDIES) {
        // BuddiesPanel manages its own innerHTML inside the container.
        body.innerHTML = "";
        this._buddiesPanel.mount(body);
      }
      if (window.lucide) window.lucide.createIcons();
    }

    async _switchTab(id) {
      if (this._activeTab === id) return;
      this._activeTab = id;
      // Lazy-load each tab on first activation. Collection is preloaded in
      // onMount because the stats above lean on the collection grid call.
      if (id === TAB_PLAYS && !this._recentPlaysLoaded) {
        this._loadRecentPlays({ reset: true });
        return;
      }
      this.render();
    }

    _statRow(s) {
      const fav = s.favorite;
      const favName = fav ? fav.name : "—";
      const favClick = fav ? `onclick="window.router.go('game-detail',{gameId:'${fav.id}',gameName:'${jsStr(fav.name || '')}'})"` : "";
      return `
        <div class="profile-stats__grid">
          <div class="profile-stat">
            <div class="profile-stat__value">${s.games}</div>
            <div class="profile-stat__label">Played Games</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat__value">${s.owned}</div>
            <div class="profile-stat__label">Owned Games</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat__value">${s.wins}</div>
            <div class="profile-stat__label">Wins</div>
          </div>
          <div class="profile-stat profile-stat--fav" ${favClick}>
            <div class="profile-stat__value profile-stat__value--text" title="${escape(favName)}">${escape(favName)}</div>
            <div class="profile-stat__label">Favorite</div>
          </div>
        </div>
      `;
    }

    // ── Collection panel ──────────────────────────────────────────────────────

    _renderCollectionPanel() {
      const totalPages = Math.max(1, Math.ceil(this._collectionTotal / COLLECTION_PER_PAGE));
      const wishlistTotalPages = Math.max(1, Math.ceil(this._wishlistTotal / WISHLIST_PER_PAGE));
      const playedTotalPages = Math.max(1, Math.ceil(this._playedTotal / PLAYED_PER_PAGE));
      const activeFilterCount = this._collectionActiveFilterCount();
      const ownedExp = (this._stats && this._stats.owned_expansions) || 0;
      const subtitle = ownedExp > 0
        ? `${this._collectionTotal} games · ${ownedExp} expansion${ownedExp === 1 ? "" : "s"}`
        : `${this._collectionTotal} games`;

      return `
        <div class="profile-panel">
          <div class="profile-panel__controls">
            <input id="collection-search-input"
                   class="input input-bordered input-sm flex-1 min-w-0"
                   placeholder="Search your collection by name"
                   autocomplete="off"
                   value="${escapeAttr(this._collectionQuery)}"
                   oninput="window.profileSelfView._onCollectionSearchInput(this.value)" />
            <button class="btn btn-ghost btn-sm relative" title="Filters"
                    onclick="window.profileSelfView._toggleCollectionFilters()">
              <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>
              ${activeFilterCount > 0 ? `<span class="search-filter-badge">${activeFilterCount}</span>` : ""}
            </button>
            <button class="btn btn-ghost btn-sm" onclick="window.router.go('game-search')">
              <i data-lucide="plus" class="w-4 h-4"></i>
            </button>
          </div>
          <header class="profile-collection__head">
            <h3 class="profile-collection__title">
              <i data-lucide="library-big" class="w-4 h-4"></i>
              Collection
            </h3>
            <span class="profile-collection__count">${escape(subtitle)}</span>
          </header>
          ${this._collectionFiltersOpen ? this._renderCollectionFilters() : ""}
          ${this._renderCollectionBody()}
          ${this._renderCollectionPager(totalPages)}
          ${this._renderWishlistSection(wishlistTotalPages)}
          ${this._renderPlayedSection(playedTotalPages)}
        </div>
      `;
    }

    _renderWishlistSection(totalPages) {
      // Wishlist sits below the owned grid as a smaller secondary shelf.
      // Hidden entirely when both empty AND not currently searching/filtering
      // — surfacing an empty shelf in the resting state would be noise.
      const isSearchingOrFiltering =
        this._collectionQuery || this._collectionActiveFilterCount() > 0;
      if (
        !this._wishlistLoading &&
        this._wishlistTotal === 0 &&
        !isSearchingOrFiltering &&
        !this._wishlistError
      ) {
        return "";
      }
      return `
        <section class="profile-wishlist">
          <header class="profile-wishlist__head">
            <h3 class="profile-wishlist__title">
              <i data-lucide="star" class="w-4 h-4"></i>
              Wishlist
            </h3>
            <span class="profile-wishlist__count">${this._wishlistTotal}</span>
          </header>
          ${this._renderWishlistBody(isSearchingOrFiltering)}
          ${this._renderWishlistPager(totalPages)}
        </section>
      `;
    }

    _renderWishlistBody(isSearchingOrFiltering) {
      if (this._wishlistError) {
        return `<div class="alert alert-error text-sm">${escape(this._wishlistError)}</div>`;
      }
      if (this._wishlistLoading && this._wishlistItems.length === 0) {
        return window.buddyLoader({ size: 72 });
      }
      if (this._wishlistItems.length === 0) {
        return `<div class="profile-empty profile-empty--sm">${isSearchingOrFiltering ? "No wishlist matches." : "Nothing on your wishlist yet."}</div>`;
      }
      const reloading = this._wishlistLoading ? "is-reloading" : "";
      return `
        <div class="profile-collection-grid ${reloading}">
          ${this._wishlistItems.map((it) => this._renderCollectionTile(it)).join("")}
        </div>
      `;
    }

    _renderWishlistPager(totalPages) {
      if (totalPages <= 1) return "";
      return `
        <nav class="search-pager">
          <button class="btn btn-ghost btn-xs" ${this._wishlistPage <= 1 ? "disabled" : ""}
                  onclick="window.profileSelfView._goWishlistPage(${this._wishlistPage - 1})">
            <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._wishlistPage} of ${totalPages}</span>
          <button class="btn btn-ghost btn-xs" ${this._wishlistPage >= totalPages ? "disabled" : ""}
                  onclick="window.profileSelfView._goWishlistPage(${this._wishlistPage + 1})">
            Next <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </button>
        </nav>
      `;
    }

    _goWishlistPage(n) { this._wishlistPage = n; this._loadWishlist(); }

    _renderPlayedSection(totalPages) {
      // Played-not-owned shelf. Hidden in the resting state when empty —
      // surfaces only if the user has played-but-uncollected games or is
      // actively searching/filtering (so an empty section under a search
      // still reads as "no matches" rather than disappearing entirely).
      const isSearchingOrFiltering =
        this._collectionQuery || this._collectionActiveFilterCount() > 0;
      if (
        !this._playedLoading &&
        this._playedTotal === 0 &&
        !isSearchingOrFiltering &&
        !this._playedError
      ) {
        return "";
      }
      return `
        <section class="profile-played">
          <header class="profile-played__head">
            <h3 class="profile-played__title">
              <i data-lucide="history" class="w-4 h-4"></i>
              Played, not owned
            </h3>
            <span class="profile-played__count">${this._playedTotal}</span>
          </header>
          ${this._renderPlayedBody(isSearchingOrFiltering)}
          ${this._renderPlayedPager(totalPages)}
        </section>
      `;
    }

    _renderPlayedBody(isSearchingOrFiltering) {
      if (this._playedError) {
        return `<div class="alert alert-error text-sm">${escape(this._playedError)}</div>`;
      }
      if (this._playedLoading && this._playedItems.length === 0) {
        return window.buddyLoader({ size: 72 });
      }
      if (this._playedItems.length === 0) {
        return `<div class="profile-empty profile-empty--sm">${isSearchingOrFiltering ? "No played-not-owned matches." : "No played-but-uncollected games."}</div>`;
      }
      const reloading = this._playedLoading ? "is-reloading" : "";
      return `
        <div class="profile-collection-grid ${reloading}">
          ${this._playedItems.map((it) => this._renderCollectionTile(it)).join("")}
        </div>
      `;
    }

    _renderPlayedPager(totalPages) {
      if (totalPages <= 1) return "";
      return `
        <nav class="search-pager">
          <button class="btn btn-ghost btn-xs" ${this._playedPage <= 1 ? "disabled" : ""}
                  onclick="window.profileSelfView._goPlayedPage(${this._playedPage - 1})">
            <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._playedPage} of ${totalPages}</span>
          <button class="btn btn-ghost btn-xs" ${this._playedPage >= totalPages ? "disabled" : ""}
                  onclick="window.profileSelfView._goPlayedPage(${this._playedPage + 1})">
            Next <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </button>
        </nav>
      `;
    }

    _goPlayedPage(n) { this._playedPage = n; this._loadPlayed(); }

    _collectionActiveFilterCount() {
      const f = this._collectionFilters;
      let n = 0;
      if (f.players) n++;
      if (f.playtimeMin != null || f.playtimeMax != null) n++;
      if (f.playMode) n++;
      return n;
    }

    _renderCollectionFilters() {
      const f = this._collectionFilters;
      const playerChip = (n) => `
        <button class="filter-chip ${f.players === n ? "is-active" : ""}"
                onclick="window.profileSelfView._setCollectionFilter('players', ${f.players === n ? "null" : n})">
          ${n === 7 ? "7+" : n}
        </button>
      `;
      const modeChip = (mode, label) => `
        <button class="filter-chip ${f.playMode === mode ? "is-active" : ""}"
                onclick="window.profileSelfView._setCollectionFilter('playMode', ${f.playMode === mode ? "null" : "'" + mode + "'"})">
          ${label}
        </button>
      `;
      return `
        <section class="search-filters">
          <div class="search-filter-group">
            <label class="search-filter-label">Players</label>
            <div class="filter-chip-row">${[1, 2, 3, 4, 5, 6, 7].map(playerChip).join("")}</div>
          </div>
          <div class="search-filter-group">
            <label class="search-filter-label">Playtime (min)</label>
            <div class="filter-chip-row">
              ${PLAYTIME_BUCKETS.map((b) => `
                <button class="filter-chip ${isActiveBucket(b, f) ? "is-active" : ""}"
                        onclick="window.profileSelfView._setCollectionPlaytimeBucket('${b.id}')">
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
          ${this._collectionActiveFilterCount() > 0
            ? `<div class="search-filters__footer">
                <button class="btn btn-ghost btn-xs" onclick="window.profileSelfView._clearCollectionFilters()">Clear filters</button>
              </div>`
            : ""}
        </section>
      `;
    }

    _renderCollectionBody() {
      if (this._collectionError) {
        return `<div class="alert alert-error text-sm">${escape(this._collectionError)}</div>`;
      }
      if (this._collectionLoading && this._collectionItems.length === 0) {
        return window.buddyLoader({ size: 88 });
      }
      if (this._collectionItems.length === 0) {
        return `<div class="profile-empty">${this._collectionQuery || this._collectionActiveFilterCount() > 0 ? "No matches in your collection." : "No owned games yet — tap the + to search."}</div>`;
      }
      // Re-fetch in flight with results in hand → dim + overlay spinner so a
      // filter/search/page change has visible feedback. Mirrors the Game
      // Search reload pattern.
      const reloading = this._collectionLoading ? "is-reloading" : "";
      return `
        <div class="profile-collection-grid ${reloading}">
          ${this._collectionItems.map((it) => this._renderCollectionTile(it)).join("")}
        </div>
      `;
    }

    _renderCollectionTile(item) {
      const g = item.game || {};
      // Prefer the viewer's collection map (lets the picker reflect "this is
      // currently on my shelf"); fall back to the row's own status — vital
      // for the "played, not owned" shelf where the game has no collection
      // row so the map can't surface it — then to null so the renderer
      // shows the "+" picker rather than an incorrect default pill.
      const status = this._statusMap[g.id] || item.status || null;
      const expCount = g.bgg_id ? (this._expansionCounts[g.bgg_id] || 0) : 0;
      return `
        <div class="collection-tile" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || '')}'})">
          ${window.renderStatusTag(g.id, status, { size: "xs" })}
          ${g.thumbnail_url
            ? `<img src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" />`
            : `<div class="collection-tile__placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="collection-tile__name">${escape(g.name || "Unknown")}</div>
          ${window.renderExpansionBadge(expCount)}
        </div>
      `;
    }

    _renderCollectionPager(totalPages) {
      if (totalPages <= 1) return "";
      return `
        <nav class="search-pager">
          <button class="btn btn-ghost btn-xs" ${this._collectionPage <= 1 ? "disabled" : ""}
                  onclick="window.profileSelfView._goCollectionPage(${this._collectionPage - 1})">
            <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._collectionPage} of ${totalPages}</span>
          <button class="btn btn-ghost btn-xs" ${this._collectionPage >= totalPages ? "disabled" : ""}
                  onclick="window.profileSelfView._goCollectionPage(${this._collectionPage + 1})">
            Next <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </button>
        </nav>
      `;
    }

    _onCollectionSearchInput(value) {
      this._collectionQuery = value;
      clearTimeout(this._collectionSearchTimer);
      this._collectionSearchTimer = setTimeout(() => {
        this._loadCollection({ reset: true });
      }, 300);
    }
    _setCollectionFilter(key, value, reload = true) {
      this._collectionFilters[key] = value;
      this._collectionPage = 1;
      if (reload) this._loadCollection({ reset: true });
      else this.render();
    }
    _clearCollectionFilters() {
      this._collectionFilters = this._emptyCollectionFilters();
      this._loadCollection({ reset: true });
    }
    _setCollectionPlaytimeBucket(id) {
      const f = this._collectionFilters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = (cur && cur.id === id) ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._loadCollection({ reset: true });
    }
    _toggleCollectionFilters() { this._collectionFiltersOpen = !this._collectionFiltersOpen; this.render(); }
    // Pager clicks scope the refetch to the affected shelf — search/filter
    // changes still hit both via _loadCollection({ reset: true }).
    _goCollectionPage(n) { this._collectionPage = n; this._loadOwned(); }

    // ── Recent plays panel ────────────────────────────────────────────────────

    _renderRecentPlaysPanel() {
      return `
        <div class="profile-panel">
          <div class="profile-panel__controls">
            <input id="recent-search-input"
                   class="input input-bordered input-sm flex-1 min-w-0"
                   placeholder="Search by game or player name"
                   autocomplete="off"
                   value="${escapeAttr(this._recentPlaysQuery)}"
                   oninput="window.profileSelfView._onRecentSearchInput(this.value)" />
            <button class="btn btn-ghost btn-sm" title="Refresh"
                    ${this._recentPlaysLoading ? "disabled" : ""}
                    onclick="window.profileSelfView._loadRecentPlays({reset:true})">
              <i data-lucide="refresh-cw" class="w-4 h-4 ${this._recentPlaysLoading ? "animate-spin" : ""}"></i>
            </button>
          </div>
          ${this._renderRecentPlaysBody()}
          ${this._renderRecentPlaysLoadMore()}
        </div>
      `;
    }

    _renderRecentPlaysBody() {
      if (this._recentPlaysError) {
        return `<div class="text-error text-sm">${escape(this._recentPlaysError)}</div>`;
      }
      if (!this._recentPlaysLoaded) {
        return window.buddyLoader({ size: 88 });
      }
      if (this._recentPlays.length === 0) {
        return `<div class="profile-empty">${this._recentPlaysQuery ? "No matches." : "No plays logged yet."}</div>`;
      }
      return `<ul class="recent-plays">${this._recentPlays.map((p) => this._renderRecentPlayRow(p)).join("")}</ul>`;
    }

    _renderRecentPlayRow(p) {
      const winners = (p.players || []).filter((pl) => pl.is_winner);
      const winnerLabel = winners.map((w) => escape(w.name)).join(", ");
      const playerCount = (p.players || []).length;
      const subParts = [];
      if (winnerLabel) {
        subParts.push(`<span class="recent-plays__winner"><i data-lucide="trophy" class="w-3 h-3"></i> ${winnerLabel}</span>`);
      }
      if (playerCount > 0) {
        subParts.push(`${playerCount} ${playerCount === 1 ? "player" : "players"}`);
      }
      // Tapping the box art routes to game-detail; rest of the row opens the
      // play. Consistent with every other place a boardgame image appears.
      // Delete now lives on the play-detail edit form, not on the row.
      const gameNav = `event.stopPropagation();window.router.go('game-detail',{gameId:'${p.game_id}',gameName:'${jsStr(p.game_name || '')}'})`;
      const statusOverlay = p.game_id
        ? `<span class="recent-plays__status">${window.renderStatusTag(p.game_id, (this._statusMap || {})[p.game_id] || null, { compact: true })}</span>`
        : "";
      return `
        <li class="recent-plays__row" data-play-id="${p.id}">
          <div class="recent-plays__row-inner"
               onclick="window.router.go('play-detail',{playId:'${p.id}'})">
            <div class="recent-plays__thumb">
              ${p.game_thumbnail
                ? `<img src="${escapeAttr(p.game_thumbnail)}" alt="" onclick="${gameNav}" />`
                : `<div class="recent-plays__placeholder"><i data-lucide="dice-6"></i></div>`}
              ${statusOverlay}
            </div>
            <div class="recent-plays__body">
              <div class="recent-plays__top">
                <div class="recent-plays__game">${escape(p.game_name)}</div>
                <div class="recent-plays__date">${formatDate(p.played_at)}</div>
              </div>
              ${subParts.length ? `<div class="recent-plays__sub">${subParts.join(" · ")}</div>` : ""}
            </div>
          </div>
        </li>
      `;
    }

    _renderRecentPlaysLoadMore() {
      const hasMore = this._recentPlays.length < this._recentPlaysTotal;
      if (!hasMore) return "";
      return `
        <div class="text-center mt-2">
          <button class="btn btn-ghost btn-xs" ${this._recentPlaysLoading ? "disabled" : ""}
                  onclick="window.profileSelfView._loadMoreRecentPlays()">
            ${this._recentPlaysLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      `;
    }

    _onRecentSearchInput(value) {
      this._recentPlaysQuery = value;
      clearTimeout(this._recentSearchTimer);
      this._recentSearchTimer = setTimeout(() => {
        this._loadRecentPlays({ reset: true });
      }, 300);
    }
    _loadMoreRecentPlays() {
      this._recentPlaysPage += 1;
      this._loadRecentPlays({ reset: false });
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  window.ProfileSelfView = ProfileSelfView;
})();
