// views/wishlist-view.js — Full wishlist spoke.
//
// Mirrors collection-view but pins status='wishlist' and drops the toggle.
// "+ Add" button in the header opens the Add Games page
// (views/add-games-view.js) — the whole BgB catalog as one scroll.
//
// Data lives in ShelfController (domain/shelf-controller.js) — the same
// fetch-once-and-window-locally model collection-view uses, right down to the
// scroll sentinel (ui/infinite-scroll.js), so the two spokes can no longer
// drift apart the way their duplicated filter code did.

(function () {
  // Seven rows of the 3-up grid — the same batch collection-view reveals.
  const BATCH_SIZE = 21;
  const MODE = "wishlist";

  const PLAYTIME_BUCKETS = window.ShelfFilter.PLAYTIME_BUCKETS;
  const isActiveBucket = window.ShelfFilter.isActiveBucket;

  class WishlistView extends window.View {
    constructor() {
      super("wishlist");
      this.ctl = new window.ShelfController({
        modes: [MODE],
        batchSize: BATCH_SIZE,
        target: () => this._shelfTarget(),
        onChange: () => this.render(),
        onNarrow: () => this._scrollToListTop(),
      });
      // Built once for the life of the singleton — _armInfinite re-points it
      // after every paint, onUnmount parks it on nothing.
      this._infinite = new window.InfiniteScroll({ onLoadMore: () => this._loadMore() });
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

    /** Paint the first batch from cache in the first frame; bundle seed as fallback. */
    _hydrateFromCache() {
      if (this.ctl.hydrate(MODE)) return true;
      const seed = window.store.get("profileBundle");
      if (!seed) return false;
      this._statusMap = seed.status_map || this._statusMap;
      return this.ctl.seedPartial(MODE, seed.wishlist_page, seed.wishlist_total);
    }

    onUnmount() {
      // The container keeps its markup while the view is hidden, so without
      // this the sentinel stays observed and a navigation away from a
      // half-scrolled wishlist would keep pulling batches nobody is reading.
      this._infinite.observe(null);
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
      this._paintList();
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
        this._armInfinite();
        return;
      }

      this.container.innerHTML = `
        ${this._renderHead()}
        ${this._renderControls()}
        <div id="wishlist-filters-host">${this._filtersOpen ? this._renderFilters() : ""}</div>
        <div id="wishlist-grid-host">${this._renderBody()}</div>
        <div id="wishlist-more-host">${this._renderMore()}</div>
      `;
      this.refreshIcons();
      this._armInfinite();

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

    /** The reveal-a-batch path: two subtree writes, no shell teardown. */
    _paintList() {
      const grid = this.container.querySelector("#wishlist-grid-host");
      const more = this.container.querySelector("#wishlist-more-host");
      if (!grid || !more) return;
      grid.innerHTML = this._renderBody();
      more.innerHTML = this._renderMore();
      this.refreshIcons(grid);
      this.refreshIcons(more);
      this._armInfinite();
    }

    /**
     * Put the viewport back at the head of a just-narrowed list. Only when it
     * is already past that point, so typing in the search box — which is at
     * the top of the grid anyway — never yanks the page around.
     */
    _scrollToListTop() {
      const grid = this.container && this.container.querySelector("#wishlist-grid-host");
      if (!grid) return;
      const top = grid.getBoundingClientRect().top + window.scrollY;
      // :root carries scroll-padding-top, so block:"start" clears the pinned
      // header without this having to know how tall it is.
      if (window.scrollY > top) grid.scrollIntoView({ block: "start" });
    }

    /**
     * Re-point the sentinel after every paint — see ui/infinite-scroll.js on
     * why re-observing is what keeps the list moving rather than a leak.
     * Resolves to null once the list is finished; observe(null) stands the
     * observer down.
     */
    _armInfinite() {
      const host = this.container;
      this._infinite.observe(host && host.querySelector("#wishlist-scroll-sentinel"));
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

    /** The catalog scroll — see CollectionView._openAddGame. */
    _openAddGame() {
      window.router.go("add-games", { status: "wishlist" });
    }

    _renderControls() {
      const activeFilters = this.ctl.activeFilterCount();
      return `
        <div class="profile-panel__controls">
          ${window.BgbSearchField.render({
            id: "wishlist-search-input",
            value: this.ctl.query,
            placeholder: "Search your wishlist by name",
            oninput: "window.wishlistView._onSearchInput(this.value)",
          })}
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

    _renderBody() {
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
      return `
        <div class="profile-collection-grid ${reloading}">
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
          ${window.renderStatusTag(g.id, status, { corner: true, gameName: g.name })}
          <div class="collection-tile__art">
            ${gameArtImg(g, "card")
              || `<div class="collection-tile__placeholder"><i data-icon="dice-6"></i></div>`}
            ${window.renderExpansionBadge(expCount, { context: "total" })}
          </div>
          <div class="collection-tile__name">${escapeHtml(g.name || "Unknown")}</div>
        </div>
      `;
    }

    /** The strip below the grid: sentinel, retry, or the end-of-list line. */
    _renderMore() {
      if (this.ctl.error[MODE]) return "";
      const shown = (this.ctl.items[MODE] || []).length;
      const total = this.ctl.total[MODE];
      return window.InfiniteScroll.renderFooter({
        id: "wishlist-scroll-sentinel",
        hasMore: this.ctl.hasMore(MODE),
        loading: this.ctl.loadingMore[MODE],
        error: this.ctl.moreError[MODE],
        onRetry: "window.wishlistView._retryMore()",
        // Only worth saying once the list ran past a batch — on a short
        // wishlist the end of it is self-evident.
        endLabel: shown > BATCH_SIZE ? `That's all ${total} game${total === 1 ? "" : "s"}.` : "",
      });
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
    _loadMore() {
      // Zero network on the local path: widen the window, then rewrite just
      // the grid and the strip under it. The server fallback returns false and
      // repaints through the controller's onChange when its batch lands.
      if (this.ctl.loadMore(MODE)) this._paintList();
    }

    _retryMore() {
      // Repaint either way: a local retry has already widened the window, and
      // a server retry needs the strip to swap the error out for the spinner.
      this.ctl.retryMore(MODE);
      this._paintList();
    }
  }

  window.WishlistView = WishlistView;
})();
