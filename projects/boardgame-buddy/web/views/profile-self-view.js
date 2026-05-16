// views/profile-self-view.js — three-tab view of the user's stuff.
//
// Tabs (no counts in the labels): Game Collection, Recent Plays, Buddies.
// Display name / BGG link / admin shortcut / logout live on Settings now
// (reachable via the global header avatar).

(function () {
  const PLAYS_PER_PAGE = 10;
  const COLLECTION_PER_PAGE = 12;
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

      // Collection
      this._collectionItems = [];
      this._collectionTotal = 0;
      this._collectionPage = 1;
      this._collectionQuery = "";
      this._collectionFilters = this._emptyCollectionFilters();
      this._collectionFiltersOpen = false;
      this._collectionLoading = false;
      this._collectionError = null;
      this._collectionSearchTimer = null;

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
      await Promise.all([
        this._loadStats(),
        this._loadCollection({ reset: true }),
        this._refreshCollectionData(),
      ]);
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

    async _loadCollection({ reset = false } = {}) {
      this._collectionLoading = true;
      this._collectionError = null;
      if (reset) this._collectionPage = 1;
      this.render();
      try {
        const qs = new URLSearchParams({
          page: String(this._collectionPage),
          per_page: String(COLLECTION_PER_PAGE),
          exclude_expansions: "true",
        });
        if (this._collectionQuery) qs.set("search", this._collectionQuery);
        const f = this._collectionFilters;
        if (f.players)       qs.set("players", String(f.players));
        if (f.playtimeMin != null) qs.set("playtime_min", String(f.playtimeMin));
        if (f.playtimeMax != null) qs.set("playtime_max", String(f.playtimeMax));
        if (f.playMode)      qs.set("play_mode", f.playMode);
        const data = await window.api.get("/collection/grid?" + qs.toString());
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
        // Bind swipe handlers on the freshly painted list. Idempotent via the
        // `dataset.swipeBound` guard inside the helper.
        this._attachRecentPlaysSwipe();
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
          <div class="profile-panel__subtitle">${escape(subtitle)}</div>
          ${this._collectionFiltersOpen ? this._renderCollectionFilters() : ""}
          ${this._renderCollectionBody()}
          ${this._renderCollectionPager(totalPages)}
        </div>
      `;
    }

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
      return `
        <div class="profile-collection-grid">
          ${this._collectionItems.map((it) => this._renderCollectionTile(it)).join("")}
        </div>
      `;
    }

    _renderCollectionTile(item) {
      const g = item.game || {};
      const status = this._statusMap[g.id] || "owned";
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
    _goCollectionPage(n) { this._collectionPage = n; this._loadCollection({ reset: false }); }

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
      // Each row has a sliding foreground + a fixed-width red "Delete" action
      // behind it on the right. The user swipes the foreground leftwards to
      // reveal Delete; tap Delete to remove the play. Non-owners (rare in
      // self-view but possible) skip the action entirely.
      const canDelete = p.is_own !== false;
      return `
        <li class="recent-plays__row ${canDelete ? "" : "is-no-swipe"}" data-play-id="${p.id}">
          ${canDelete ? `
            <button class="recent-plays__delete" aria-label="Delete play"
                    onclick="event.stopPropagation();window.profileSelfView._confirmDeleteRecentPlay('${p.id}')">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
              <span>Delete</span>
            </button>` : ""}
          <div class="recent-plays__row-inner"
               onclick="window.profileSelfView._openRecentPlay(event,'${p.id}')">
            ${p.game_thumbnail ? `<img src="${escapeAttr(p.game_thumbnail)}" alt="" />` : `<div class="recent-plays__placeholder"><i data-lucide="dice-6"></i></div>`}
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

    // ── Swipe-to-delete on recent plays ──────────────────────────────────────
    // The handlers live on the view (not the row) so re-renders don't drop the
    // listeners. The view delegates from a single touchstart on the list and
    // tracks per-row state via the closest `.recent-plays__row` ancestor.

    _attachRecentPlaysSwipe() {
      const list = this.container.querySelector(".recent-plays");
      if (!list || list.dataset.swipeBound === "1") return;
      list.dataset.swipeBound = "1";
      const view = this;
      let activeRow = null;
      let startX = 0;
      let startY = 0;
      let dx = 0;
      let locked = null; // "horizontal" | "vertical" | null
      const REVEAL = 88; // px — matches `.recent-plays__delete` width

      const reset = () => {
        if (activeRow) {
          const inner = activeRow.querySelector(".recent-plays__row-inner");
          if (inner) inner.style.transition = "";
        }
        activeRow = null;
        startX = startY = dx = 0;
        locked = null;
      };

      list.addEventListener("touchstart", (e) => {
        const row = e.target.closest(".recent-plays__row");
        if (!row || row.classList.contains("is-no-swipe")) return;
        activeRow = row;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        dx = 0;
        locked = null;
        const inner = row.querySelector(".recent-plays__row-inner");
        if (inner) inner.style.transition = "none";
      }, { passive: true });

      list.addEventListener("touchmove", (e) => {
        if (!activeRow) return;
        const t = e.touches[0];
        const rawDx = t.clientX - startX;
        const rawDy = t.clientY - startY;
        if (locked == null) {
          if (Math.abs(rawDx) < 6 && Math.abs(rawDy) < 6) return;
          locked = Math.abs(rawDx) > Math.abs(rawDy) ? "horizontal" : "vertical";
          if (locked === "vertical") {
            const inner = activeRow.querySelector(".recent-plays__row-inner");
            if (inner) inner.style.transition = "";
            activeRow = null;
            return;
          }
        }
        const wasOpen = activeRow.classList.contains("is-swiped");
        const base = wasOpen ? -REVEAL : 0;
        dx = Math.max(-REVEAL, Math.min(0, base + rawDx));
        const inner = activeRow.querySelector(".recent-plays__row-inner");
        if (inner) inner.style.transform = `translateX(${dx}px)`;
      }, { passive: true });

      const finish = (e) => {
        if (!activeRow) return;
        const wasHorizontal = locked === "horizontal";
        const inner = activeRow.querySelector(".recent-plays__row-inner");
        if (inner) inner.style.transition = "";
        if (inner) inner.style.transform = "";
        if (dx <= -REVEAL / 2) activeRow.classList.add("is-swiped");
        else activeRow.classList.remove("is-swiped");
        if (wasHorizontal) {
          // Mobile browsers synthesize a click on the touched element ~300ms
          // after touchend. Without this guard the click immediately fires
          // _openRecentPlay → sees `is-swiped` → unswipes the row before the
          // user ever sees the Delete affordance. Block for 400ms.
          view._swipeClickBlockUntil = Date.now() + 400;
          if (e && e.cancelable) e.preventDefault();
        }
        reset();
      };
      list.addEventListener("touchend", finish);
      list.addEventListener("touchcancel", finish);
    }

    _openRecentPlay(event, playId) {
      // Suppress the synthetic click that arrives right after a swipe gesture
      // (set by `finish()` in _attachRecentPlaysSwipe). Without this, a fresh
      // swipe would self-cancel.
      if (this._swipeClickBlockUntil && Date.now() < this._swipeClickBlockUntil) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        return;
      }
      // Tapping a swiped-open row closes it instead of drilling in — gives
      // users a clean way to dismiss the Delete affordance.
      const row = event && event.currentTarget && event.currentTarget.closest(".recent-plays__row");
      if (row && row.classList.contains("is-swiped")) {
        row.classList.remove("is-swiped");
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      window.router.go("play-detail", { playId });
    }

    async _confirmDeleteRecentPlay(playId) {
      if (!confirm("Delete this play? This can't be undone.")) {
        // User backed out — close the swipe affordance so the row reads tidy.
        const row = this.container.querySelector(`.recent-plays__row[data-play-id="${playId}"]`);
        if (row) row.classList.remove("is-swiped");
        return;
      }
      try {
        await window.Play.remove(playId);
      } catch (e) {
        alert(e.message || "Failed to delete");
        return;
      }
      // Bust the feed cache so the deleted play disappears the next time the
      // feed paints. Locally, drop it from the recent-plays list and patch
      // the total so the pager + "load more" stay accurate.
      if (window.store && window.store.invalidate) window.store.invalidate("feed");
      this._recentPlays = (this._recentPlays || []).filter((p) => p.id !== playId);
      this._recentPlaysTotal = Math.max(0, this._recentPlaysTotal - 1);
      // Refresh stats too — wins / play counts may have shifted.
      this._loadStats();
      this.render();
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
