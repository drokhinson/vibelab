// views/collection-view.js — Full collection spoke.
//
// Toggle between "Owned" and "Played, not owned" + shared search/filters.
// Wishlist lives at its own /wishlist route. The "+ Add" button in the
// header opens the AddGameModal (widgets/add-game-modal.js) for searching
// the BgB library or importing from BGG.
//
// Data lives in ShelfController (domain/shelf-controller.js): a whole shelf is
// fetched once and cached, and every page, filter and search is derived from
// it locally. Page turns do no I/O. This file owns markup and painting only.
//
// Repaints are surgical: render() rebuilds the shell only when something
// structural changes, and a page turn rewrites just the grid and pager hosts.
// A full container.innerHTML per page turn is itself the "laggy" feel
// (.claude/rules/web-frontend.md), independent of the network.

(function () {
  const PER_PAGE = 12;
  const MODE_OWNED = "owned";
  const MODE_PLAYED = "played";

  const PLAYTIME_BUCKETS = window.ShelfFilter.PLAYTIME_BUCKETS;
  const isActiveBucket = window.ShelfFilter.isActiveBucket;

  class CollectionView extends window.View {
    constructor() {
      super("collection");
      this.ctl = new window.ShelfController({
        modes: [MODE_OWNED, MODE_PLAYED],
        perPage: PER_PAGE,
        target: () => this._shelfTarget(),
        otherUserId: () => (this._isOther() ? this._targetUserId : null),
        onChange: () => this.render(),
      });
      this._resetState();
    }

    _resetState() {
      this._mode = MODE_OWNED;
      this._filtersOpen = false;
      this._statusMap = {};
      this._targetUserId = null;
      this._targetProfile = null;
      this._lastSig = null;
      if (this.ctl) this.ctl.reset();
    }

    _isOther() {
      const me = window.store.get("user");
      return !!(this._targetUserId && me && this._targetUserId !== me.id);
    }

    /** Cache/query target — the viewer's own id when no userId param is set. */
    _shelfTarget() {
      if (this._targetUserId) return this._targetUserId;
      const me = window.store.get("user");
      return (me && me.id) || "me";
    }

    async onMount() {
      this.listen("user", () => this.render());
      this.listen("myCollectionMap", () => this._refreshMaps());
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this.ctl.spliceGame(gameId, status);
        this.ctl.deriveAll();
        this.render();
      });
      await this._initFromParams();
    }

    async onParamsChange() {
      await this._initFromParams();
    }

    /**
     * Paint before awaiting anything: a cached shelf renders page 1 in this
     * frame, and survives a hard reload because bgbCache writes through to
     * localStorage. Falls back to the profile bundle's first page, then to a
     * spinner.
     */
    _hydrateFromCache() {
      if (this.ctl.hydrate(MODE_OWNED)) return true;
      if (this._isOther()) return false;
      const seed = window.store.get("profileBundle");
      if (!seed) return false;
      this._statusMap = seed.status_map || this._statusMap;
      return this.ctl.seedPartial(MODE_OWNED, seed.owned_page, seed.owned_total);
    }

    async _initFromParams() {
      // The view instance is a singleton across mounts (init.js wires it
      // once). Reset before reading params so user A's items don't linger
      // on screen while user B's fetch is in flight.
      this._resetState();
      this._targetUserId = (this.params && this.params.userId) || null;

      if (this._isOther()) {
        this._hydrateFromCache();
        this.render();
        window.User.fetch(this._targetUserId)
          .then((p) => { this._targetProfile = p; this.render(); })
          .catch(() => {});
        await this.ctl.load(MODE_OWNED);
        // Viewer maps still apply — overlay "you own this" pills on
        // the other user's tiles.
        await this._refreshMaps();
        return;
      }

      // Self path — paint from cache, then let SWR decide whether to refresh.
      this._hydrateFromCache();
      // The Played tab is lazy (see _setMode): nothing on first paint needs its
      // contents, and the bundle already carries its count for the toggle pill.
      const seed = window.store.get("profileBundle");
      if (seed && typeof seed.played_total === "number") {
        this.ctl.total[MODE_PLAYED] = seed.played_total;
      }
      this.render();
      await Promise.all([
        this.ctl.load(MODE_OWNED),
        this._refreshMaps(),
      ]);
    }

    renderLoading() {
      // Runs BEFORE onMount, so read the route params here rather than trusting
      // instance fields — this view is a singleton and _targetUserId still
      // holds the PREVIOUS mount's target until _initFromParams runs.
      this._resetState();
      this._targetUserId = (this.params && this.params.userId) || null;
      this._hydrateFromCache();
      this.render();
    }

    async _refreshMaps() {
      try {
        this._statusMap = (await window.Collection.myStatusMap()) || {};
      } catch (_) {}
      if (!this._mounted) return;
      this.render();
    }

    // ── Painting ──────────────────────────────────────────────────────────────
    /**
     * Only things that change the shell's *structure* belong here. Filter
     * chips, the filter badge, counts, the grid and the pager are all patched
     * in place, so they must stay out of this signature.
     */
    _structuralSig() {
      return [
        this._mode,
        this._isOther() ? "other" : "self",
        (this._targetProfile && this._targetProfile.display_name) || "",
        this.ctl.isColdLoad(this._mode) ? "cold" : "warm",
      ].join("|");
    }

    render() {
      this.ctl.derive(this._mode);
      const sig = this._structuralSig();
      if (sig !== this._lastSig || !this.container.querySelector("#collection-grid-host")) {
        this._renderShell();
        this._lastSig = sig;
        return;
      }
      this._paintCounts();
      this._paintFilters();
      this._paintPage();
    }

    _renderShell() {
      const active = document.activeElement;
      const activeId = active && active.id;
      const caret = active && active.selectionStart;

      if (this.ctl.isColdLoad(this._mode)) {
        this.container.innerHTML = `
          ${this._renderHead()}
          <div class="profile-loading">
            ${window.buddyLoader({ size: 96, label: "Loading collection…" })}
          </div>
        `;
        this.refreshIcons();
        return;
      }

      const other = this._isOther();
      this.container.innerHTML = `
        ${this._renderHead()}
        ${other ? "" : this._renderControls()}
        ${other ? "" : this._renderToggle()}
        <div id="collection-filters-host">${this._filtersOpen ? this._renderFilters() : ""}</div>
        <div id="collection-grid-host">${this._renderBody(this._hasPager())}</div>
        <div id="collection-pager-host">${this._renderPager()}</div>
      `;
      this.refreshIcons();

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

    _hasPager() {
      return this.ctl.totalPages(this._mode) > 1;
    }

    /** The page-turn path: two subtree writes, no shell teardown. */
    _paintPage() {
      const grid = this.container.querySelector("#collection-grid-host");
      const pager = this.container.querySelector("#collection-pager-host");
      if (!grid || !pager) return;
      grid.innerHTML = this._renderBody(this._hasPager());
      pager.innerHTML = this._renderPager();
      this.refreshIcons(grid);
      this.refreshIcons(pager);
    }

    /** Header count + toggle pills — text only, so no teardown. */
    _paintCounts() {
      const total = this.ctl.total[this._mode];
      const head = this.container.querySelector(".spoke-head__count");
      if (head) head.textContent = `${total} game${total === 1 ? "" : "s"}`;
      const pills = this.container.querySelectorAll(".spoke-toggle__count");
      if (pills.length === 2) {
        pills[0].textContent = String(this.ctl.total[MODE_OWNED]);
        pills[1].textContent = String(this.ctl.total[MODE_PLAYED]);
      }
    }

    /** Filter panel + the badge on the filter button. */
    _paintFilters() {
      const host = this.container.querySelector("#collection-filters-host");
      if (host) {
        host.innerHTML = this._filtersOpen ? this._renderFilters() : "";
        this.refreshIcons(host);
      }
      const btn = this.container.querySelector("#collection-filter-btn");
      if (!btn) return;
      const n = this.ctl.activeFilterCount();
      const badge = btn.querySelector(".search-filter-badge");
      if (n > 0 && badge) badge.textContent = String(n);
      else if (n > 0) btn.insertAdjacentHTML("beforeend", `<span class="search-filter-badge">${n}</span>`);
      else if (badge) badge.remove();
    }

    _renderHead() {
      const total = this.ctl.total[this._mode];
      const other = this._isOther();
      const backJs = other
        ? `window.router.go('profile-other',{userId:'${escapeAttr(this._targetUserId)}'})`
        : "window.router.go('profile-self')";
      const p = this._targetProfile;
      let titleHtml;
      if (other && p && p.display_name) {
        const badge = window.BgbBadge.render({ avatar: p.avatar, displayName: p.display_name, size: "sm" });
        titleHtml = `${badge}<span class="spoke-head__title-text">${escapeHtml(p.display_name)}'s collection</span>`;
      } else {
        titleHtml = `<span class="spoke-head__title-text">Collection</span>`;
      }
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" onclick="${backJs}" aria-label="Back to profile">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">${titleHtml}</h2>
          <span class="spoke-head__count">${total} game${total === 1 ? "" : "s"}</span>
          ${other ? "" : `
            <button class="spoke-head__add btn btn-primary btn-sm"
                    onclick="window.collectionView._openAddGame()"
                    aria-label="Add a game to your collection">
              <i data-icon="plus" class="w-4 h-4"></i><span>Add</span>
            </button>
          `}
        </header>
      `;
    }

    _openAddGame() {
      window.AddGameModal.open({
        status: "owned",
        onAdded: () => { this.ctl.load(this._mode, { force: true }); },
      });
    }

    _renderControls() {
      const activeFilters = this.ctl.activeFilterCount();
      return `
        <div class="profile-panel__controls">
          <input id="collection-search-input"
                 class="input input-bordered flex-1 min-w-0"
                 placeholder="Search your collection by name"
                 autocomplete="off"
                 value="${escapeAttr(this.ctl.query)}"
                 oninput="window.collectionView._onSearchInput(this.value)" />
          <button id="collection-filter-btn" class="btn btn-ghost relative" title="Filters"
                  onclick="window.collectionView._toggleFilters()">
            <i data-icon="sliders-horizontal" class="w-4 h-4"></i>
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
            Owned <span class="spoke-toggle__count">${this.ctl.total[MODE_OWNED]}</span>
          </button>
          <button class="spoke-toggle__pill ${playedActive}"
                  role="tab" aria-selected="${this._mode === MODE_PLAYED}"
                  onclick="window.collectionView._setMode('${MODE_PLAYED}')">
            Played, not owned <span class="spoke-toggle__count">${this.ctl.total[MODE_PLAYED]}</span>
          </button>
        </div>
      `;
    }

    _renderFilters() {
      const f = this.ctl.filters;
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
          ${this.ctl.activeFilterCount() > 0
            ? `<div class="search-filters__footer">
                <button class="btn btn-ghost btn-xs" onclick="window.collectionView._clearFilters()">Clear filters</button>
              </div>`
            : ""}
        </section>
      `;
    }

    _renderBody(hasPager = false) {
      const mode = this._mode;
      if (this.ctl.error[mode]) {
        return `<div class="alert alert-error text-sm">${escapeHtml(this.ctl.error[mode])}</div>`;
      }
      const items = this.ctl.items[mode] || [];
      if (this.ctl.isPending(mode) && items.length === 0) {
        return `<div class="profile-loading">${window.buddyLoader({ size: 88, label: "Loading collection…" })}</div>`;
      }
      if (items.length === 0) {
        const isSearchingOrFiltering = this.ctl.isNarrowing();
        let empty;
        if (this._isOther()) {
          const who = (this._targetProfile && this._targetProfile.display_name) || "They";
          empty = `${who} doesn't own any games yet.`;
        } else if (mode === MODE_OWNED) {
          empty = isSearchingOrFiltering ? "No matches in your collection." : "No owned games yet — tap the + to add one.";
        } else {
          empty = isSearchingOrFiltering ? "No played-not-owned matches." : "No played-but-uncollected games.";
        }
        return `<div class="profile-empty">${escapeHtml(empty)}</div>`;
      }
      const reloading = this.ctl.loading[mode] ? "is-reloading" : "";
      const paginated = hasPager ? "is-paginated" : "";
      return `
        <div class="profile-collection-grid ${reloading} ${paginated}">
          ${items.map((it) => this._renderTile(it)).join("")}
        </div>
      `;
    }

    _renderTile(item) {
      const g = item.game || {};
      const status = this._statusMap[g.id] || item.status || null;
      // Catalog-wide count, straight off the shelf row — the same number the
      // game page's "Expansions (N)" heading shows. bgb_collection_shelf
      // computes it in SQL, so the badge is right on the first cached paint.
      const expCount = g.expansion_count || 0;
      return `
        <div class="collection-tile" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || "")}'})">
          ${window.renderStatusTag(g.id, status, { size: "xs", gameName: g.name })}
          <div class="collection-tile__art">
            ${gameArtImg(g, "card")
              || `<div class="collection-tile__placeholder"><i data-icon="dice-6"></i></div>`}
            ${window.renderExpansionBadge(expCount, { context: "total" })}
          </div>
          <div class="collection-tile__name">${escapeHtml(g.name || "Unknown")}</div>
        </div>
      `;
    }

    _renderPager() {
      const totalPages = this.ctl.totalPages(this._mode);
      if (totalPages <= 1) return "";
      const page = this.ctl.page[this._mode];
      return `
        <nav class="spoke-pager-footer" aria-label="Collection pagination">
          <button class="btn btn-primary spoke-pager-footer__btn" ${page <= 1 ? "disabled" : ""}
                  onclick="window.collectionView._goPage(${page - 1})"
                  aria-label="Previous page">
            <i data-icon="chevron-left" class="w-4 h-4"></i><span>Prev</span>
          </button>
          <span class="spoke-pager-footer__page">Page ${page} of ${totalPages}</span>
          <button class="btn btn-primary spoke-pager-footer__btn" ${page >= totalPages ? "disabled" : ""}
                  onclick="window.collectionView._goPage(${page + 1})"
                  aria-label="Next page">
            <span>Next</span><i data-icon="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    _setMode(mode) {
      if (this._mode === mode) return;
      this._mode = mode;
      // Lazy first load for the Played tab.
      if (!this.ctl.shelf[mode] && !this.ctl.loading[mode]) this.ctl.load(mode);
      else this.render();
    }
    _onSearchInput(value) { this.ctl.onSearchInput(value, this._mode); }
    _setFilter(key, value) { this.ctl.setFilter(key, value, this._mode); }
    _clearFilters() { this.ctl.clearFilters(this._mode); }
    _setPlaytimeBucket(id) { this.ctl.setPlaytimeBucket(id, this._mode); }
    _toggleFilters() {
      this._filtersOpen = !this._filtersOpen;
      this._paintFilters();
    }
    _goPage(n) {
      // Zero network: derive the page, then rewrite just the grid and pager.
      if (this.ctl.goPage(n, this._mode)) {
        this._paintPage();
        this._paintCounts();
      }
    }
  }

  window.CollectionView = CollectionView;
})();
