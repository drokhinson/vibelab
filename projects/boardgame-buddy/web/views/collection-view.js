// views/collection-view.js — Full collection spoke.
//
// Toggle between "Owned", "Expansions" and "Played" + shared
// search/filters (Owned and Played only — see below).
// Wishlist lives at its own /wishlist route. The "+ Add" button in the
// header opens the AddGameModal (widgets/add-game-modal.js) for searching
// the BgB library or importing from BGG.
//
// Data lives in ShelfController (domain/shelf-controller.js): a whole shelf is
// fetched once and cached, and the visible window, filter and search are all
// derived from it locally. The grid scrolls rather than pages — an
// IntersectionObserver on a sentinel below the last row (ui/infinite-scroll.js)
// reveals the next batch, which on the local path costs no I/O at all. This
// file owns markup and painting only.
//
// The Expansions tab is deliberately NOT a ShelfController mode. That class is
// paging-and-filtering machinery over one flat, server-ordered list per
// CollectionStatus: it passes the mode straight through as the `status` query
// param (which "expansions" is not), and its filter spec hard-codes
// excludeExpansions, which would strip every row the tree exists to show.
// Bending it would mean four conditionals in a class Wishlist also uses. The
// tree keeps its own small state here instead, fetched from the same
// /collection/shelf endpoint with expansions included and grouped by
// domain/expansion-tree.js.
//
// Repaints are surgical: render() rebuilds the shell only when something
// structural changes, and revealing a batch rewrites just the grid and
// sentinel hosts. A full container.innerHTML per batch is itself the "laggy"
// feel (.claude/rules/web-frontend.md), independent of the network — and here
// it would also throw away the scroll position the user is reading from.

(function () {
  // Seven rows of the 3-up grid. Deep enough that one batch is a couple of
  // screens on a phone, so the sentinel is well below the fold when it arms.
  const BATCH_SIZE = 21;
  const MODE_OWNED = "owned";
  const MODE_PLAYED = "played";
  const MODE_EXPANSIONS = "expansions";

  // One table drives the toggle pills, the header count and the count noun, so
  // adding a fourth mode can't leave a pill wired to nothing. The previous
  // hand-written pair indexed .spoke-toggle__count positionally and guarded on
  // `pills.length === 2`, which silently stopped updating every count the
  // moment a third pill appeared.
  const MODES = [
    { id: MODE_OWNED, label: "Owned", noun: "game" },
    { id: MODE_EXPANSIONS, label: "Expansions", noun: "expansion" },
    { id: MODE_PLAYED, label: "Played", noun: "game" },
  ];

  const PLAYTIME_BUCKETS = window.ShelfFilter.PLAYTIME_BUCKETS;
  const isActiveBucket = window.ShelfFilter.isActiveBucket;

  // Per-device preference for the Expansions tab. localStorage rather than the
  // server: it is a view setting, worthless to another device, and reading it
  // must never be able to fail a render — hence the try/catch on both sides.
  const SHOW_ALL_KEY = "bgb.collection.expansionsShowAll";

  function _readShowAll() {
    try { return localStorage.getItem(SHOW_ALL_KEY) === "1"; } catch (_) { return false; }
  }

  function _writeShowAll(on) {
    try { localStorage.setItem(SHOW_ALL_KEY, on ? "1" : "0"); } catch (_) {}
  }

  class CollectionView extends window.View {
    constructor() {
      super("collection");
      this.ctl = new window.ShelfController({
        modes: [MODE_OWNED, MODE_PLAYED],
        batchSize: BATCH_SIZE,
        target: () => this._shelfTarget(),
        otherUserId: () => (this._isOther() ? this._targetUserId : null),
        onChange: () => this.render(),
        onNarrow: () => this._scrollToListTop(),
      });
      // Built once for the life of the singleton, not per mount: _armInfinite
      // re-points it after every paint, and onUnmount parks it on nothing.
      this._infinite = new window.InfiniteScroll({ onLoadMore: () => this._loadMore() });
      this._resetState();
    }

    _resetState() {
      this._mode = MODE_OWNED;
      this._filtersOpen = false;
      this._statusMap = {};
      this._targetUserId = null;
      this._targetProfile = null;
      this._lastSig = null;
      this._resetTreeState();
      if (this.ctl) this.ctl.reset();
    }

    /** Expansions-tab state. View-local — see the header on why not ShelfController. */
    _resetTreeState() {
      this._treeRows = null;
      this._tree = { groups: [], totalOwned: 0 };
      this._treeOpen = {};
      this._treeLoading = false;
      this._treeError = null;
      this._treeTruncated = false;
      this._treeLoadedOnce = false;
      this._treeCatalog = null;
      this._treeCatalogLoading = false;
      this._treeCatalogSeq = 0;
      // A view preference, not data — remembered so the tab doesn't snap back
      // to owned-only on every navigation.
      this._treeShowAll = _readShowAll();
      // Monotonic guard: a slow load must not overwrite a newer one, and an
      // add's rollback must not fire after a later add superseded it.
      this._treeSeq = 0;
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
      // Delegated once on the view container: the tree rewrites
      // #collection-grid-host wholesale, so per-row handlers would need
      // re-binding on every paint.
      const onTreeClick = (e) => {
        if (e.target.closest("[data-exp-toggle-all]")) {
          this._toggleAllGroups();
          return;
        }
        const toggle = e.target.closest("[data-exp-toggle]");
        if (toggle) {
          this._toggleExpGroup(toggle.getAttribute("data-exp-toggle"));
          return;
        }
        const addOne = e.target.closest("[data-exp-add-one]");
        if (addOne) {
          // Stop the tap reaching the row beneath, which navigates.
          e.stopPropagation();
          this._addExpansionById(addOne.getAttribute("data-exp-add-one"));
          return;
        }
        const imp = e.target.closest("[data-exp-import]");
        if (imp) {
          this._openExpansionImport(imp.getAttribute("data-exp-import"));
          return;
        }
        const add = e.target.closest("[data-exp-add]");
        if (add) this._openExpansionPicker(add.getAttribute("data-exp-add"), add);
      };
      this.container.addEventListener("click", onTreeClick);
      // The view is a singleton remounted per navigation, so the teardown goes
      // through the base class's _unsubs or the handler stacks up per mount.
      this._unsubs.push(() => this.container.removeEventListener("click", onTreeClick));
      this.listen("user", () => this.render());
      this.listen("myCollectionMap", () => this._refreshMaps());
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this.ctl.spliceGame(gameId, status);
        this.ctl.deriveAll();
        this._spliceTree(gameId, status);
        this.render();
      });
      await this._initFromParams();
    }

    async onParamsChange() {
      await this._initFromParams();
    }

    onUnmount() {
      // The container keeps its markup while the view is hidden, so without
      // this the sentinel stays observed and a navigation away from a
      // half-scrolled shelf would keep pulling batches nobody is looking at.
      this._infinite.observe(null);
    }

    /**
     * Paint before awaiting anything: a cached shelf renders its first batch
     * in this frame, and survives a hard reload because bgbCache writes
     * through to localStorage. Falls back to the profile bundle's first page
     * (`owned_page` — the bundle's own field name), then to a spinner.
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
      this._seedTreeCount();
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
     * chips, the filter badge, counts, the grid and the scroll strip are all
     * patched in place, so they must stay out of this signature.
     */
    _structuralSig() {
      // In tree mode the shell has no controls, filters or sentinel, so the
      // cold->loaded transition is structural: without it the first paint
      // falls into _paintList against an empty tree and never rebuilds.
      const treeState = this._mode === MODE_EXPANSIONS
        ? (this._treeRows ? "tree-warm" : "tree-cold")
        : "";
      return [
        this._mode,
        this._isOther() ? "other" : "self",
        (this._targetProfile && this._targetProfile.display_name) || "",
        this._mode === MODE_EXPANSIONS ? treeState : (this.ctl.isColdLoad(this._mode) ? "cold" : "warm"),
      ].join("|");
    }

    render() {
      // "expansions" is not one of the controller's modes — deriving it would
      // write junk items/total/page keys onto it under that name.
      if (this._mode !== MODE_EXPANSIONS) this.ctl.derive(this._mode);
      const sig = this._structuralSig();
      if (sig !== this._lastSig || !this.container.querySelector("#collection-grid-host")) {
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

      if (this._mode !== MODE_EXPANSIONS && this.ctl.isColdLoad(this._mode)) {
        this.container.innerHTML = `
          ${this._renderHead()}
          <div class="profile-loading">
            ${window.buddyLoader({ size: 96, label: "Loading collection…" })}
          </div>
        `;
        this.refreshIcons();
        this._armInfinite();
        return;
      }

      const other = this._isOther();
      // Search and the filter panel are ShelfFilter-derived over the flat
      // shelf — players, playtime and play mode, none of which mean anything
      // for an expansion — and the search box is bound to the controller's
      // shared query. The tree tops out around 40 groups, so it earns neither.
      const tree = this._mode === MODE_EXPANSIONS;
      this.container.innerHTML = `
        ${this._renderHead()}
        ${other || tree ? "" : this._renderControls()}
        ${other ? "" : this._renderToggle()}
        <div id="collection-tree-controls-host">${tree ? this._renderTreeControls() : ""}</div>
        <div id="collection-filters-host">${!tree && this._filtersOpen ? this._renderFilters() : ""}</div>
        <div id="collection-grid-host">${this._renderBody()}</div>
        <div id="collection-more-host">${this._renderMore()}</div>
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
      const grid = this.container.querySelector("#collection-grid-host");
      const more = this.container.querySelector("#collection-more-host");
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
      const grid = this.container && this.container.querySelector("#collection-grid-host");
      if (!grid) return;
      const top = grid.getBoundingClientRect().top + window.scrollY;
      // :root carries scroll-padding-top, so block:"start" clears the pinned
      // header without this having to know how tall it is.
      if (window.scrollY > top) grid.scrollIntoView({ block: "start" });
    }

    /**
     * Re-point the sentinel after every paint — see ui/infinite-scroll.js on
     * why re-observing is what keeps the list moving rather than a leak.
     * Resolves to null whenever the list is finished (or the tree is up), and
     * observe(null) is how the observer is stood down.
     */
    _armInfinite() {
      const host = this.container;
      this._infinite.observe(host && host.querySelector("#collection-scroll-sentinel"));
    }

    _modeTotal(mode) {
      if (mode === MODE_EXPANSIONS) return this._tree.totalOwned;
      return this.ctl.total[mode] || 0;
    }

    _countLabel(mode) {
      const n = this._modeTotal(mode);
      const entry = MODES.find((m) => m.id === mode);
      const noun = (entry && entry.noun) || "game";
      return `${n} ${noun}${n === 1 ? "" : "s"}`;
    }

    /** Header count + toggle pills — text only, so no teardown. */
    _paintCounts() {
      const head = this.container.querySelector(".spoke-head__count");
      if (head) head.textContent = this._countLabel(this._mode);
      // Looked up by mode, not by position: the old positional version was
      // guarded on exactly two pills and went silent when a third arrived.
      this.container.querySelectorAll("[data-mode-count]").forEach((el) => {
        el.textContent = String(this._modeTotal(el.getAttribute("data-mode-count")));
      });
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
          <span class="spoke-head__count">${this._countLabel(this._mode)}</span>
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
      return `
        <div class="spoke-toggle spoke-toggle--${MODES.length}" role="tablist">
          ${MODES.map((m) => `
            <button class="spoke-toggle__pill ${this._mode === m.id ? "is-active" : ""}"
                    role="tab" aria-selected="${this._mode === m.id}"
                    onclick="window.collectionView._setMode('${m.id}')">
              <span class="spoke-toggle__label">${escapeHtml(m.label)}</span>
              <span class="spoke-toggle__count" data-mode-count="${m.id}">${this._modeTotal(m.id)}</span>
            </button>
          `).join("")}
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

    _renderBody() {
      const mode = this._mode;
      if (mode === MODE_EXPANSIONS) return this._renderTreeBody();
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
      return `
        <div class="profile-collection-grid ${reloading}">
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

    // ── Expansions tab ────────────────────────────────────────────────────────

    _renderTreeBody() {
      if (this._treeError) {
        return `<div class="alert alert-error text-sm">${escapeHtml(this._treeError)}</div>`;
      }
      if (this._treeLoading && !this._treeRows) {
        return `<div class="profile-loading">${window.buddyLoader({ size: 88, label: "Loading expansions…" })}</div>`;
      }
      const groups = this._tree.groups || [];
      if (!groups.length && this._treeShowAll && this._treeCatalogLoading) {
        return `<div class="profile-loading">${window.buddyLoader({ size: 88, label: "Loading expansions…" })}</div>`;
      }
      if (!groups.length) {
        // Distinct from "you own no expansions": a shelf with no base game
        // that HAS any expansions in the catalog has nothing to nest under.
        return `<div class="profile-empty">Nothing to show yet — expansions appear here under the games you own.</div>`;
      }
      const truncated = this._treeTruncated
        ? `<p class="exp-tree__truncated">Showing the first slice of a very large collection.</p>`
        : "";
      return window.renderExpansionTree(this._tree, { open: this._treeOpen, showAll: this._treeShowAll })
        + truncated;
    }

    /**
     * The tree's pinned control band: what each group lists (owned-only vs the
     * whole catalog) on the left, and whether the groups are open on the
     * right. It sits in its own shell host — #collection-tree-controls-host —
     * rather than inside the body, for two reasons: _paintTree() rewrites the
     * body wholesale, which would tear the pinned row down under the user's
     * thumb, and the body has three separate return paths that would each have
     * had to remember to prepend it (the cold-load one didn't).
     */
    _renderTreeControls() {
      const on = this._treeShowAll;
      const busy = on && this._treeCatalogLoading && !this._treeCatalog;
      const groups = (this._tree && this._tree.groups) || [];
      const anyOpen = this._anyGroupOpen();
      // One control, two directions: with anything open it closes everything,
      // otherwise it opens everything. Derived from _treeOpen on every paint
      // rather than stored, so a per-group tap can't leave it lying.
      const allLabel = anyOpen ? "Collapse all" : "Expand all";
      return `
        <div class="exp-tree__controls">
          <button type="button" class="exp-tree__switch ${on ? "is-on" : ""}"
                  role="switch" aria-checked="${on}"
                  onclick="window.collectionView._toggleShowAll()">
            <span class="exp-tree__switch-track"><span class="exp-tree__switch-knob"></span></span>
            <span>Show all expansions</span>
          </button>
          ${busy ? `<span class="exp-tree__controls-note">Loading…</span>` : ""}
          <button type="button" class="exp-tree__all" data-exp-toggle-all
                  aria-label="${allLabel} expansion groups" ${groups.length ? "" : "disabled"}>
            <i data-icon="${anyOpen ? "chevron-up" : "chevron-down"}" class="w-4 h-4"></i>
            <span>${allLabel}</span>
          </button>
        </div>`;
    }

    /** True when at least one group is currently disclosed. */
    _anyGroupOpen() {
      const groups = (this._tree && this._tree.groups) || [];
      return groups.some((g) => !!this._treeOpen[String(g.baseId)]);
    }

    /**
     * Open or close every group at once. Surgical on purpose: _paintTree()
     * would rebuild the whole body — and, since the controls row is pinned,
     * would also swap the very element the user just tapped mid-gesture.
     */
    _toggleAllGroups() {
      const open = !this._anyGroupOpen();
      const groups = (this._tree && this._tree.groups) || [];
      for (const g of groups) {
        const key = String(g.baseId);
        this._treeOpen[key] = open;
        window.expansionTreeToggle(this.container, key, open);
      }
      this._paintTreeControls();
    }

    /** Repaint just the pinned band — switch state, note, all-toggle label. */
    _paintTreeControls() {
      const host = this.container.querySelector("#collection-tree-controls-host");
      if (!host) return;
      host.innerHTML = this._mode === MODE_EXPANSIONS ? this._renderTreeControls() : "";
      this.refreshIcons(host);
    }

    /** Regroup from the flat rows, keeping whatever the user has expanded. */
    _rebuildTree() {
      this._tree = window.buildExpansionTree(this._treeRows || [], {
        catalog: this._treeCatalog,
        showAll: this._treeShowAll,
      });
      const defaults = window.expansionTreeDefaultOpen(this._tree.groups);
      for (const key of Object.keys(defaults)) {
        if (!(key in this._treeOpen)) this._treeOpen[key] = defaults[key];
      }
    }

    _setTreeRows(items, truncated) {
      this._treeRows = items || [];
      this._treeTruncated = !!truncated;
      this._rebuildTree();
    }

    /**
     * Paint from cache first so the tab has content in its first frame, same
     * contract as ShelfController.hydrate for the other two tabs.
     */
    _hydrateTree() {
      const cached = window.Collection.cachedShelf(this._shelfTarget(), MODE_OWNED, {
        includeExpansions: true,
      });
      if (!cached || !cached.items) return false;
      this._setTreeRows(cached.items, cached.truncated);
      return true;
    }

    /**
     * Give the Expansions pill a number before the tab is ever opened —
     * otherwise it reads "0" next to two populated pills and looks broken.
     *
     * A cached expansions-shelf is exact. Failing that, the already-loaded
     * status map's per-base-game owned counts are close: they miss owned
     * expansions whose base_game_bgg_id is null, which the tree shows in its
     * trailing group. Either way _loadTree corrects it.
     */
    _seedTreeCount() {
      if (this._hydrateTree()) return;
      const counts = window.Collection.cachedExpansionCounts
        ? window.Collection.cachedExpansionCounts()
        : null;
      if (!counts) return;
      let n = 0;
      for (const key of Object.keys(counts)) n += counts[key] || 0;
      this._tree = { groups: [], totalOwned: n };
    }

    async _loadTree({ force = false } = {}) {
      const seq = ++this._treeSeq;
      this._treeLoading = true;
      this._treeError = null;
      this.render();
      try {
        const data = await window.Collection.shelf(this._shelfTarget(), MODE_OWNED, {
          includeExpansions: true,
          force,
        });
        if (seq !== this._treeSeq) return;
        this._setTreeRows(data.items, data.truncated);
      } catch (e) {
        if (seq !== this._treeSeq) return;
        this._treeError = (e && e.message) || "Couldn't load your expansions.";
      }
      this._treeLoading = false;
      this.render();
    }

    /**
     * Keep the tree in step with a status change from anywhere in the app.
     * Removal only: an "owned" we didn't put here ourselves has no row to
     * build from, and the next load picks it up.
     */
    _spliceTree(gameId, status) {
      if (!this._treeRows) return;
      if (status === "owned") return;
      const next = this._treeRows.filter((r) => r.game_id !== gameId);
      if (next.length === this._treeRows.length) return;
      this._treeRows = next;
      this._rebuildTree();
    }

    /** Tree hosts only — no shell teardown, so the scroll position holds. */
    _paintTree() {
      const grid = this.container.querySelector("#collection-grid-host");
      if (!grid) return;
      grid.innerHTML = this._renderTreeBody();
      this.refreshIcons(grid);
      // The band reads state the body just changed — the show-all switch, the
      // Loading… note, and whether anything is open — so it repaints with it.
      this._paintTreeControls();
    }

    /**
     * Flip owned-only vs show-all. The catalog is fetched on first turn-on and
     * kept after that, so toggling back and forth is free.
     */
    _toggleShowAll() {
      this._treeShowAll = !this._treeShowAll;
      _writeShowAll(this._treeShowAll);
      this._rebuildTree();
      this._paintTree();
      if (this._treeShowAll && !this._treeCatalog && !this._treeCatalogLoading) {
        this._loadCatalog();
      }
    }

    async _loadCatalog({ force = false } = {}) {
      const seq = ++this._treeCatalogSeq;
      this._treeCatalogLoading = true;
      this._paintTree();
      try {
        const items = await window.Collection.expansionCatalog(this._shelfTarget(), { force });
        if (seq !== this._treeCatalogSeq) return;
        this._treeCatalog = items || [];
      } catch (e) {
        if (seq !== this._treeCatalogSeq) return;
        // Non-fatal: the tab still shows what you own. Turning the switch back
        // off is the recovery, so it says so rather than blanking the tree.
        this._treeCatalog = [];
        this._treeError = null;
        window.PolaroidPopup.alert({
          title: "Couldn't load the catalog",
          body: (e && e.message) || "Showing the expansions you own instead.",
        });
        this._treeShowAll = false;
        _writeShowAll(false);
      }
      this._treeCatalogLoading = false;
      this._rebuildTree();
      this._paintTree();
      this._paintCounts();
    }

    _toggleExpGroup(key) {
      const open = !this._treeOpen[key];
      this._treeOpen[key] = open;
      // Surgical: flipping one group must not rebuild the tree under the
      // user's thumb (.claude/rules/web-frontend.md).
      window.expansionTreeToggle(this.container, key, open);
      // Opening the first group has to flip the band's control to "Collapse
      // all", and closing the last one back to "Expand all".
      this._paintTreeControls();
    }

    /** The + on an unowned row in show-all mode. */
    _addExpansionById(gameId) {
      for (const group of this._tree.groups || []) {
        const kid = group.kids.find((k) => k.gameId === gameId && !k.owned);
        if (!kid) continue;
        this._addExpansion(group, {
          expansion_game_id: kid.gameId,
          bgg_id: kid.game.bgg_id,
          name: kid.game.name,
          thumbnail_url: kid.game.thumbnail_url,
          image_url: kid.game.image_url,
          color: kid.game.expansion_color,
        });
        return;
      }
    }

    /**
     * Straight to the BGG import popup. Only reachable in show-all mode, where
     * the picker would only repeat the catalog rows already on screen.
     */
    _openExpansionImport(key) {
      const group = (this._tree.groups || []).find((g) => String(g.baseId) === String(key));
      if (!group || !group.canAdd) return;
      window.ImportExpansionsModal.open({
        gameId: group.baseId,
        gameName: group.name,
        onImported: () => {
          // An import changes the catalog, not anyone's collection, so it
          // misses Collection.invalidateShelves() — refetch explicitly or the
          // new expansion won't appear until the cache ages out.
          this._loadCatalog({ force: true });
        },
      });
    }

    _openExpansionPicker(key, trigger) {
      const group = (this._tree.groups || []).find((g) => String(g.baseId) === String(key));
      if (!group || !group.canAdd) return;
      window.ExpansionPickerSheet.open({
        baseGameId: group.baseId,
        baseGameName: group.name,
        ownedIds: group.kids.filter((k) => k.owned).map((k) => k.gameId),
        returnFocus: trigger || null,
        onPick: (exp) => this._addExpansion(group, exp),
      });
    }

    /**
     * Optimistic add: the row lands in the tree in the same frame as the tap,
     * and the write flows through behind it. Rollback is field-level (this one
     * row and this one status) rather than a whole-state restore, so a
     * concurrent add to another group isn't erased.
     */
    async _addExpansion(group, exp) {
      const gameId = exp.expansion_game_id;
      if (!gameId || !this._treeRows) return;
      const seq = ++this._treeSeq;
      const prevStatus = this._statusMap[gameId] || null;
      const baseGame = (group.base && group.base.game) || {};

      const row = {
        id: `pending-${gameId}`,
        game_id: gameId,
        status: MODE_OWNED,
        added_at: new Date().toISOString(),
        game: {
          id: gameId,
          bgg_id: exp.bgg_id,
          name: exp.name,
          thumbnail_url: exp.thumbnail_url,
          image_url: exp.image_url,
          is_expansion: true,
          base_game_bgg_id: baseGame.bgg_id != null ? baseGame.bgg_id : null,
          expansion_color: exp.color,
          expansion_count: 0,
        },
      };

      this._treeRows.push(row);
      this._rebuildTree();
      this._treeOpen[String(group.baseId)] = true;
      this._statusMap[gameId] = MODE_OWNED;
      this._paintTree();
      this._paintCounts();

      try {
        // Collection.add already fans out invalidateMyStatusMap(), which drops
        // every cached shelf (both shapes), the profile bundle, the game
        // bundle and cached game searches. Nothing extra to invalidate.
        await window.Collection.add(gameId, MODE_OWNED);
        if (seq !== this._treeSeq) return;
        this._emitStatus(gameId, MODE_OWNED);
      } catch (e) {
        if (seq !== this._treeSeq) return;
        this._treeRows = this._treeRows.filter((r) => r.game_id !== gameId);
        this._rebuildTree();
        if (prevStatus == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = prevStatus;
        this._paintTree();
        this._paintCounts();
        window.PolaroidPopup.alert({
          title: "Couldn't add",
          body: (e && e.message) || "That expansion didn't make it onto your shelf. Try again.",
        });
      }
    }

    /**
     * Tell the rest of the app. Fired only after the write lands: the local
     * tree is already painted, and an optimistic broadcast would make every
     * other live grid roll back too if this failed.
     */
    _emitStatus(gameId, status) {
      const map = window.store.get("myCollectionMap");
      if (map) window.store.set("myCollectionMap", { ...map, [gameId]: status });
      document.dispatchEvent(new CustomEvent("status-changed", { detail: { gameId, status } }));
    }

    /** The strip below the grid: sentinel, retry, or the end-of-list line. */
    _renderMore() {
      // The tree renders every group it has, so it has no window to grow and
      // must not carry a sentinel — the controller doesn't track "expansions"
      // as a mode, and asking it for one writes junk keys under that name.
      const mode = this._mode;
      if (mode === MODE_EXPANSIONS) return "";
      if (this.ctl.error[mode]) return "";
      const shown = (this.ctl.items[mode] || []).length;
      return window.InfiniteScroll.renderFooter({
        id: "collection-scroll-sentinel",
        hasMore: this.ctl.hasMore(mode),
        loading: this.ctl.loadingMore[mode],
        error: this.ctl.moreError[mode],
        onRetry: "window.collectionView._retryMore()",
        // Only worth saying once the list actually ran past a batch; on a
        // twelve-game shelf the end of the list is self-evident.
        endLabel: shown > BATCH_SIZE ? `That's all ${this._countLabel(mode)}.` : "",
      });
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    _setMode(mode) {
      if (this._mode === mode) return;
      this._mode = mode;
      // Each tab keeps its own scroll window, so a tab arrived at from deep in
      // another one must start at its head — otherwise the viewport lands on
      // the new tab's sentinel and unrolls a list the user hasn't looked at.
      // Measured before the repaint on purpose: the grid host sits at the same
      // document position in all three tabs, and this only ever scrolls UP.
      this._scrollToListTop();
      if (mode === MODE_EXPANSIONS) {
        // Lazy, like the Played tab. Paint whatever is cached in the frame the
        // pill was tapped in, then let SWR correct it — _loadTree still runs
        // on a warm hydrate, or the tab would serve a cached shelf forever.
        if (!this._treeRows) this._hydrateTree();
        this.render();
        if (!this._treeLoadedOnce && !this._treeLoading) {
          this._treeLoadedOnce = true;
          this._loadTree();
        }
        // The switch is a remembered preference, so it can already be on the
        // first time the tab is opened this session.
        if (this._treeShowAll && !this._treeCatalog && !this._treeCatalogLoading) {
          this._loadCatalog();
        }
        return;
      }
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
    _loadMore() {
      // Zero network on the local path: widen the window, then rewrite just
      // the grid and the strip under it. The server fallback returns false and
      // repaints through the controller's onChange when its batch lands.
      if (this.ctl.loadMore(this._mode)) this._paintList();
    }

    _retryMore() {
      // Repaint either way: a local retry has already widened the window, and
      // a server retry needs the strip to swap the error out for the spinner.
      this.ctl.retryMore(this._mode);
      this._paintList();
    }
  }

  window.CollectionView = CollectionView;
})();
