// views/wishlist-view.js — Full wishlist spoke.
//
// Mirrors collection-view but pins status='wishlist' and drops the toggle.
// "+ Add" button in the header opens the AddGameModal for searching the
// BgB library or importing from BGG.
//
// Data lives in ShelfController (domain/shelf-controller.js) — the same
// fetch-once-and-page-locally model collection-view uses, so the two spokes
// can no longer drift apart the way their duplicated filter code did.

(function () {
  const PER_PAGE = 12;
  const MODE = "wishlist";

  const PLAYTIME_BUCKETS = window.ShelfFilter.PLAYTIME_BUCKETS;
  const isActiveBucket = window.ShelfFilter.isActiveBucket;

  class WishlistView extends window.View {
    constructor() {
      super("wishlist");
      this.ctl = new window.ShelfController({
        modes: [MODE],
        perPage: PER_PAGE,
        target: () => this._shelfTarget(),
        onChange: () => this.render(),
      });
      this._filtersOpen = false;
      this._statusMap = {};
      this._lastSig = null;
    }

    _shelfTarget() {
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
      this._hydrateFromCache();
      this.render();
      await Promise.all([this.ctl.load(MODE), this._refreshMaps()]);
    }

    /** Paint page 1 from cache in the first frame; bundle seed as fallback. */
    _hydrateFromCache() {
      if (this.ctl.hydrate(MODE)) return true;
      const seed = window.store.get("profileBundle");
      if (!seed) return false;
      this._statusMap = seed.status_map || this._statusMap;
      return this.ctl.seedPartial(MODE, seed.wishlist_page, seed.wishlist_total);
    }

    renderLoading() {
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
    _structuralSig() {
      return this.ctl.isColdLoad(MODE) ? "cold" : "warm";
    }

    render() {
      this.ctl.derive(MODE);
      const sig = this._structuralSig();
      if (sig !== this._lastSig || !this.container.querySelector("#wishlist-grid-host")) {
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

      if (this.ctl.isColdLoad(MODE)) {
        this.container.innerHTML = `
          ${this._renderHead()}
          <div class="p-4 grid place-items-center">${window.buddyLoader({ size: 64 })}</div>
        `;
        this.refreshIcons();
        return;
      }

      this.container.innerHTML = `
        ${this._renderHead()}
        ${this._renderControls()}
        <div id="wishlist-filters-host">${this._filtersOpen ? this._renderFilters() : ""}</div>
        <div id="wishlist-grid-host">${this._renderBody(this._hasPager())}</div>
        <div id="wishlist-pager-host">${this._renderPager()}</div>
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
      return this.ctl.totalPages(MODE) > 1;
    }

    /** The page-turn path: two subtree writes, no shell teardown. */
    _paintPage() {
      const grid = this.container.querySelector("#wishlist-grid-host");
      const pager = this.container.querySelector("#wishlist-pager-host");
      if (!grid || !pager) return;
      grid.innerHTML = this._renderBody(this._hasPager());
      pager.innerHTML = this._renderPager();
      this.refreshIcons(grid);
      this.refreshIcons(pager);
    }

    _paintCounts() {
      const total = this.ctl.total[MODE];
      const head = this.container.querySelector(".spoke-head__count");
      if (head) head.textContent = `${total} game${total === 1 ? "" : "s"}`;
    }

    _paintFilters() {
      const host = this.container.querySelector("#wishlist-filters-host");
      if (host) {
        host.innerHTML = this._filtersOpen ? this._renderFilters() : "";
        this.refreshIcons(host);
      }
      const btn = this.container.querySelector("#wishlist-filter-btn");
      if (!btn) return;
      const n = this.ctl.activeFilterCount();
      const badge = btn.querySelector(".search-filter-badge");
      if (n > 0 && badge) badge.textContent = String(n);
      else if (n > 0) btn.insertAdjacentHTML("beforeend", `<span class="search-filter-badge">${n}</span>`);
      else if (badge) badge.remove();
    }

    _renderHead() {
      const total = this.ctl.total[MODE];
      return `
        <header class="spoke-head">
          <button class="spoke-head__back" onclick="window.router.go('profile-self')" aria-label="Back to profile">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">Wishlist</h2>
          <span class="spoke-head__count">${total} game${total === 1 ? "" : "s"}</span>
          <button class="spoke-head__add btn btn-primary btn-sm"
                  onclick="window.wishlistView._openAddGame()"
                  aria-label="Add a game to your wishlist">
            <i data-icon="plus" class="w-4 h-4"></i><span>Add</span>
          </button>
        </header>
      `;
    }

    _openAddGame() {
      window.AddGameModal.open({
        status: "wishlist",
        onAdded: () => { this.ctl.load(MODE, { force: true }); },
      });
    }

    _renderControls() {
      const activeFilters = this.ctl.activeFilterCount();
      return `
        <div class="profile-panel__controls">
          <input id="wishlist-search-input"
                 class="input input-bordered flex-1 min-w-0"
                 placeholder="Search your wishlist by name"
                 autocomplete="off"
                 value="${escapeAttr(this.ctl.query)}"
                 oninput="window.wishlistView._onSearchInput(this.value)" />
          <button id="wishlist-filter-btn" class="btn btn-ghost relative" title="Filters"
                  onclick="window.wishlistView._toggleFilters()">
            <i data-icon="sliders-horizontal" class="w-4 h-4"></i>
            ${activeFilters > 0 ? `<span class="search-filter-badge">${activeFilters}</span>` : ""}
          </button>
        </div>
      `;
    }

    _renderFilters() {
      const f = this.ctl.filters;
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
          ${this.ctl.activeFilterCount() > 0
            ? `<div class="search-filters__footer">
                <button class="btn btn-ghost btn-xs" onclick="window.wishlistView._clearFilters()">Clear filters</button>
              </div>`
            : ""}
        </section>
      `;
    }

    _renderBody(hasPager = false) {
      if (this.ctl.error[MODE]) {
        return `<div class="alert alert-error text-sm">${escapeHtml(this.ctl.error[MODE])}</div>`;
      }
      const items = this.ctl.items[MODE] || [];
      if (this.ctl.isPending(MODE) && items.length === 0) {
        return window.buddyLoader({ size: 88 });
      }
      if (items.length === 0) {
        const isSearchingOrFiltering = this.ctl.isNarrowing();
        return `<div class="profile-empty">${isSearchingOrFiltering ? "No wishlist matches." : "Wishlist is empty — tap the + Add button to add a game."}</div>`;
      }
      const reloading = this.ctl.loading[MODE] ? "is-reloading" : "";
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
      // Catalog-wide count off the shelf row — see collection-view._renderTile.
      const expCount = g.expansion_count || 0;
      return `
        <div class="collection-tile" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || "")}'})">
          ${window.renderStatusTag(g.id, status, { size: "xs" })}
          ${g.thumbnail_url
            ? `<img src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" />`
            : `<div class="collection-tile__placeholder"><i data-icon="dice-6"></i></div>`}
          <div class="collection-tile__name">${escapeHtml(g.name || "Unknown")}</div>
          ${window.renderExpansionBadge(expCount, { context: "total" })}
        </div>
      `;
    }

    _renderPager() {
      const totalPages = this.ctl.totalPages(MODE);
      if (totalPages <= 1) return "";
      const page = this.ctl.page[MODE];
      return `
        <nav class="spoke-pager-footer" aria-label="Wishlist pagination">
          <button class="btn btn-primary spoke-pager-footer__btn" ${page <= 1 ? "disabled" : ""}
                  onclick="window.wishlistView._goPage(${page - 1})"
                  aria-label="Previous page">
            <i data-icon="chevron-left" class="w-4 h-4"></i><span>Prev</span>
          </button>
          <span class="spoke-pager-footer__page">Page ${page} of ${totalPages}</span>
          <button class="btn btn-primary spoke-pager-footer__btn" ${page >= totalPages ? "disabled" : ""}
                  onclick="window.wishlistView._goPage(${page + 1})"
                  aria-label="Next page">
            <span>Next</span><i data-icon="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    _onSearchInput(value) { this.ctl.onSearchInput(value, MODE); }
    _setFilter(key, value) { this.ctl.setFilter(key, value, MODE); }
    _clearFilters() { this.ctl.clearFilters(MODE); }
    _setPlaytimeBucket(id) { this.ctl.setPlaytimeBucket(id, MODE); }
    _toggleFilters() {
      this._filtersOpen = !this._filtersOpen;
      this._paintFilters();
    }
    _goPage(n) {
      // Zero network: derive the page, then rewrite just the grid and pager.
      if (this.ctl.goPage(n, MODE)) {
        this._paintPage();
        this._paintCounts();
      }
    }
  }

  window.WishlistView = WishlistView;
})();
