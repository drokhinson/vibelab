// views/collection-view.js — Full collection spoke.
//
// Toggle between "Owned", "Played, not owned" and "Expansions" + shared
// search/filters (the first two only — see below).
// Wishlist lives at its own /wishlist route. The "+ Add" button in the
// header opens the AddGameModal (widgets/add-game-modal.js) for searching
// the BgB library or importing from BGG.
//
// Data lives in ShelfController (domain/shelf-controller.js): a whole shelf is
// fetched once and cached, and every page, filter and search is derived from
// it locally. Page turns do no I/O. This file owns markup and painting only.
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
// structural changes, and a page turn rewrites just the grid and pager hosts.
// A full container.innerHTML per page turn is itself the "laggy" feel
// (.claude/rules/web-frontend.md), independent of the network.

(function () {
  const PER_PAGE = 12;
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
    { id: MODE_PLAYED, label: "Played, not owned", noun: "game" },
    { id: MODE_EXPANSIONS, label: "Expansions", noun: "expansion" },
  ];

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
        const toggle = e.target.closest("[data-exp-toggle]");
        if (toggle) {
          this._toggleExpGroup(toggle.getAttribute("data-exp-toggle"));
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
     * chips, the filter badge, counts, the grid and the pager are all patched
     * in place, so they must stay out of this signature.
     */
    _structuralSig() {
      // In tree mode the shell has no controls, filters or pager, so the
      // cold->loaded transition is structural: without it the first paint
      // falls into _paintPage against an empty tree and never rebuilds.
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
      this._paintPage();
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
        <div id="collection-filters-host">${!tree && this._filtersOpen ? this._renderFilters() : ""}</div>
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
      if (this._mode === MODE_EXPANSIONS) return false;
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

    _renderBody(hasPager = false) {
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

    // ── Expansions tab ────────────────────────────────────────────────────────

    _renderTreeBody() {
      if (this._treeError) {
        return `<div class="alert alert-error text-sm">${escapeHtml(this._treeError)}</div>`;
      }
      if (this._treeLoading && !this._treeRows) {
        return `<div class="profile-loading">${window.buddyLoader({ size: 88, label: "Loading expansions…" })}</div>`;
      }
      const groups = this._tree.groups || [];
      if (!groups.length) {
        // Distinct from "you own no expansions": a shelf with no base game
        // that HAS any expansions in the catalog has nothing to nest under.
        return `<div class="profile-empty">Nothing to show yet — expansions appear here under the games you own.</div>`;
      }
      const truncated = this._treeTruncated
        ? `<p class="exp-tree__truncated">Showing the first slice of a very large collection.</p>`
        : "";
      return window.renderExpansionTree(this._tree, { open: this._treeOpen }) + truncated;
    }

    /** Regroup from the flat rows, keeping whatever the user has expanded. */
    _rebuildTree() {
      this._tree = window.buildExpansionTree(this._treeRows || []);
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

    /** Grid host only — no shell teardown, so the scroll position holds. */
    _paintTree() {
      const grid = this.container.querySelector("#collection-grid-host");
      if (!grid) return;
      grid.innerHTML = this._renderTreeBody();
      this.refreshIcons(grid);
    }

    _toggleExpGroup(key) {
      const open = !this._treeOpen[key];
      this._treeOpen[key] = open;
      // Surgical: flipping one group must not rebuild the tree under the
      // user's thumb (.claude/rules/web-frontend.md).
      window.expansionTreeToggle(this.container, key, open);
    }

    _openExpansionPicker(key, trigger) {
      const group = (this._tree.groups || []).find((g) => String(g.baseId) === String(key));
      if (!group || !group.canAdd) return;
      window.ExpansionPickerSheet.open({
        baseGameId: group.baseId,
        baseGameName: group.name,
        ownedIds: group.kids.map((k) => k.game_id),
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

    _renderPager() {
      // The tree isn't paged. Without this guard totalPages("expansions")
      // divides an undefined total and the `<= 1` early-return loses to NaN,
      // rendering a live "Page undefined of NaN" nav.
      if (this._mode === MODE_EXPANSIONS) return "";
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
