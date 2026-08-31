// views/add-games-view.js — "Add games": the whole BgB catalog as one scroll,
// with a single tap per row to put a game on your shelf or take it off again.
//
// This replaced a search modal. The old "+ Add" on the Collection and Wishlist
// spokes opened AddGameModal, which meant the only way to reach a game was to
// already know its name and type it — fine for "I just bought Ark Nova",
// useless for "what does BgB even have?". The catalog is browsable, so it is
// browsed: every base game, alphabetical, revealed a batch at a time by the
// same scroll sentinel the two spokes use (ui/infinite-scroll.js).
//
// The modal survives as this page's escape hatch, opened from the one control
// above the list, because the one thing a catalog scroll cannot do is reach a
// game BoardGameGeek has and BgB has not imported yet.
//
// One page serves both shelves. `status` picks which on entry (the spoke you
// came from) and the toggle switches it without refetching anything — the
// catalog is viewer-independent, so only the per-row buttons change.
//
// Rows are `renderGamePolaroid(..., { variant: "row" })` with the quick action
// as a sibling, which is the shape the Expansions tree already uses: the tile
// navigates to the game page, the button beside it mutates, and the two never
// fight over one tap target.

// @ts-check

(function () {
  // Server page size. Bigger than the spokes' 21 because these are 44px list
  // rows, not three-up grid tiles — a batch has to be worth a round trip.
  const PER_PAGE = 30;

  // Catalog pages are viewer-independent and change only when a game is
  // imported, so they cache per query string. Same contract as the Game
  // Explorer's own catalog namespace, kept separate because the two ask for
  // different page sizes and a different sort.
  const CATALOG_NS = "game.catalog";
  const CATALOG_FRESH_TTL_MS = 3 * 60 * 1000;
  const CATALOG_STALE_TTL_MS = 30 * 60 * 1000;

  // Long enough that a fast typer sends one request, short enough that the
  // list feels like it is tracking the box.
  const SEARCH_DEBOUNCE_MS = 220;

  /** @typedef {"owned"|"wishlist"} Shelf */

  // One table drives the toggle pills, the header verb, the aria-labels and
  // the spoke each shelf goes back to, so a third shelf can't leave one of
  // them wired to nothing.
  const SHELVES = [
    { id: "owned",    label: "Collection", noun: "collection", route: "collection", icon: "library-big" },
    { id: "wishlist", label: "Wishlist",   noun: "wishlist",   route: "wishlist",   icon: "star" },
  ];

  /** @param {string} id @returns {typeof SHELVES[number]} */
  function shelfOf(id) {
    return SHELVES.find((s) => s.id === id) || SHELVES[0];
  }

  class AddGamesView extends window.View {
    constructor() {
      super("add-games");
      // Built once for the life of the singleton — _armInfinite re-points it
      // after every paint, onUnmount parks it on nothing.
      this._infinite = new window.InfiniteScroll({ onLoadMore: () => this._loadMore() });
      this._resetState();
    }

    _resetState() {
      /** @type {Shelf} */
      this._shelf = "owned";
      this._query = "";
      this._games = [];
      this._total = 0;
      this._page = 0;          // pages actually loaded; 0 = nothing yet
      this._loading = false;   // a FIRST page is in flight
      this._loadingMore = false;
      this._loadedOnce = false;
      this._error = null;      // first-load failure — gets its own branch
      this._moreError = null;  // batch failure — blocks the sentinel until retried
      this._statusMap = {};
      this._mapPending = true; // don't guess "not on your shelf" before the map lands
      /** @type {Set<string>} Game ids with a collection write in flight. */
      this._pending = new Set();
      // Monotonic: a page resolving after a newer search must not write back.
      this._loadSeq = 0;
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Runs BEFORE onMount, so it reads route params rather than instance
     * fields — this view is a singleton and _shelf still holds the previous
     * mount's target until this resets it.
     */
    renderLoading() {
      this._resetState();
      const wanted = (this.params && this.params.status) || "";
      if (wanted === "owned" || wanted === "wishlist") this._shelf = wanted;
      this._hydrateStatusMap();
      this._renderShell();
    }

    async onMount() {
      // One delegated listener on the container: every paint rewrites the list
      // host wholesale, so per-row handlers would need re-binding each time.
      const onClick = (e) => {
        const btn = e.target.closest("[data-catalog-add]");
        if (!btn) return;
        // The row beneath navigates to the game page; this tap does not.
        e.preventDefault();
        e.stopPropagation();
        this._toggle(btn.getAttribute("data-catalog-add"));
      };
      this.container.addEventListener("click", onClick);
      // The view is a singleton remounted per navigation, so the teardown goes
      // through the base class's _unsubs or the handler stacks up per mount.
      this._unsubs.push(() => this.container.removeEventListener("click", onClick));

      this.listen("myCollectionMap", (m) => {
        if (!m) return;
        this._statusMap = m;
        this._mapPending = false;
        this._syncRows();
      });
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = (e && e.detail) || {};
        if (!gameId) return;
        // A fresh object rather than a delete on the shared one: the store
        // hands out the same map every reader holds.
        const next = { ...this._statusMap };
        if (status == null) delete next[gameId];
        else next[gameId] = status;
        this._statusMap = next;
        this._mapPending = false;
        this._syncRows();
      });

      // Independent of the catalog: the rows paint without it (with their
      // buttons held back until it lands), so the list must not wait on it.
      window.Collection.myStatusMap()
        .then((m) => {
          if (!this._mounted || !m) return;
          this._statusMap = m;
          this._mapPending = false;
          this._syncRows();
        })
        .catch(() => {
          // Degrade to "+" rather than leaving every row's button hidden for
          // the rest of the session — same call the status tag makes.
          if (!this._mounted) return;
          this._mapPending = false;
          this._syncRows();
        });

      await this._load({ reset: true });
    }

    async onParamsChange() {
      this.renderLoading();
      await this._load({ reset: true });
    }

    onUnmount() {
      // The container keeps its markup while the view is hidden, so without
      // this the sentinel stays observed and a navigation away from a
      // half-scrolled catalog would keep pulling pages nobody is reading.
      this._infinite.observe(null);
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }

    /** Paint the buttons from whatever the device already knows, in frame one. */
    _hydrateStatusMap() {
      const m = window.store.get("myCollectionMap")
        || (window.Collection.cachedStatusMap && window.Collection.cachedStatusMap());
      if (m) {
        this._statusMap = m;
        this._mapPending = false;
      }
    }

    // ── Data ──────────────────────────────────────────────────────────────────

    _queryString(page) {
      const qs = new URLSearchParams();
      qs.set("page", String(page));
      qs.set("per_page", String(PER_PAGE));
      // Expansions attach through a base game's expansion section, never as a
      // top-level shelf entry — the same exclusion /search applies everywhere.
      qs.set("exclude_expansions", "true");
      // The row shows no expansion badge, and filling the count costs the
      // endpoint a whole second round trip per page. Opt out.
      qs.set("include_expansion_counts", "false");
      // Import order is noise on a browse-everything screen, and it is the
      // order every other collection surface already lists games in.
      qs.set("sort", "alphabetical");
      if (this._query) qs.set("search", this._query);
      return qs.toString();
    }

    _fetchPage(page) {
      const qs = this._queryString(page);
      return window.bgbCache.swr(
        CATALOG_NS,
        qs,
        () => window.api.get("/games?" + qs),
        { freshTtl: CATALOG_FRESH_TTL_MS, staleTtl: CATALOG_STALE_TTL_MS },
      );
    }

    /**
     * First page, or a fresh first page after a search change. Marks the fetch
     * in flight BEFORE the first paint so the empty state can never render
     * over a list that is still on its way (.claude/rules/web-frontend.md).
     */
    async _load({ reset = false } = {}) {
      const seq = ++this._loadSeq;
      if (reset) {
        this._games = [];
        this._total = 0;
        this._page = 0;
        this._loadedOnce = false;
        this._moreError = null;
      }
      this._loading = true;
      this._error = null;
      this._paintList();
      try {
        const data = await this._fetchPage(1);
        if (seq !== this._loadSeq) return;
        this._games = (data && data.games) || [];
        this._total = (data && data.total) || 0;
        this._page = 1;
        this._loadedOnce = true;
      } catch (e) {
        if (seq !== this._loadSeq) return;
        this._error = (e && e.message) || "Couldn't load the game library.";
      } finally {
        if (seq === this._loadSeq) {
          this._loading = false;
          this._paintCount();
          this._paintList();
        }
      }
    }

    /**
     * Reveal the next page. Guarded three ways, all of which the sentinel can
     * otherwise trip: a batch already in the air (it re-arms on every paint),
     * a failed batch (or it retries the same failing request on every scroll),
     * and a list that has run out.
     */
    async _loadMore() {
      if (this._loading || this._loadingMore || this._moreError) return;
      if (!this._hasMore()) return;
      const seq = this._loadSeq;
      const next = this._page + 1;
      this._loadingMore = true;
      this._paintMore();
      try {
        const data = await this._fetchPage(next);
        if (seq !== this._loadSeq) return;
        const games = (data && data.games) || [];
        this._games = this._games.concat(games);
        this._total = (data && data.total) || this._total;
        this._page = next;
        // A page that comes back empty while the reported total says there is
        // more would otherwise leave the sentinel asking forever.
        if (games.length === 0) this._total = this._games.length;
      } catch (e) {
        if (seq !== this._loadSeq) return;
        this._moreError = (e && e.message) || "Couldn't load more games.";
      } finally {
        if (seq === this._loadSeq) {
          this._loadingMore = false;
          this._paintList();
        }
      }
    }

    _retryMore() {
      this._moreError = null;
      this._paintMore();
      this._loadMore();
    }

    /** Compare against what is actually drawable, not the reported total alone. */
    _hasMore() {
      return this._loadedOnce && this._games.length > 0 && this._games.length < this._total;
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    /**
     * The whole point of the screen: one tap adds the game to the active
     * shelf, one more takes it off again. Optimistic — the button flips in the
     * tap's own frame and rolls back if the write fails.
     *
     * A game already on the OTHER shelf moves rather than duplicating:
     * POST /collection upserts on (user, game), so wishlist → owned is the
     * same call as nothing → owned.
     *
     * @param {string} gameId
     */
    async _toggle(gameId) {
      if (!gameId || this._pending.has(gameId)) return;
      const target = this._shelf;
      const prev = this._statusMap[gameId] || null;
      const removing = prev === target;

      this._pending.add(gameId);
      // Patches the shared map and announces it, which lands back here through
      // the status-changed listener and repaints the row.
      window.Collection.applyLocalStatus(gameId, removing ? null : target);
      this._syncRows();
      try {
        if (removing) await window.Collection.removeByGame(gameId);
        else await window.Collection.add(gameId, target);
      } catch (e) {
        window.Collection.applyLocalStatus(gameId, prev);
        const noun = shelfOf(target).noun;
        window.PolaroidPopup.alert({
          title: removing ? "Couldn't remove that" : "Couldn't add that",
          body: (e && e.message)
            || `The game didn't reach your ${noun} — check your connection and try again.`,
        });
      } finally {
        this._pending.delete(gameId);
        this._syncRows();
      }
    }

    // ── Painting ──────────────────────────────────────────────────────────────

    /**
     * The shell is built once per mount and never rebuilt: nothing above the
     * list host is structural (the toggle is a fixed pair of pills whose only
     * variable is a class, the count is text) and rebuilding it would drop the
     * search box's focus and caret on every keystroke.
     */
    render() {
      if (!this.container.querySelector("#add-games-list-host")) {
        this._renderShell();
        return;
      }
      this._paintCount();
      this._paintToggle();
      this._paintList();
    }

    _renderShell() {
      const s = shelfOf(this._shelf);
      this.container.innerHTML = `
        <header class="spoke-head">
          <button class="spoke-head__back" onclick="window.addGamesView._back()"
                  aria-label="Back to your ${escapeAttr(s.noun)}">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
          </button>
          <h2 class="spoke-head__title font-display">
            <span class="spoke-head__title-text">Add games</span>
          </h2>
          <span class="spoke-head__count" id="add-games-count">${escapeHtml(this._countLabel())}</span>
        </header>

        <p class="catalog-lede">Every game in BoardgameBuddy. Tap to put one on your shelf — tap again to take it off.</p>

        ${this._renderToggle()}

        <div class="profile-panel__controls">
          <input id="add-games-search-input"
                 class="input input-bordered flex-1 min-w-0"
                 placeholder="Search the game library"
                 autocomplete="off" autocapitalize="off" autocorrect="off"
                 value="${escapeAttr(this._query)}"
                 oninput="window.addGamesView._onSearchInput(this.value)" />
        </div>

        <button type="button" class="catalog-import" onclick="window.addGamesView._openBggImport()">
          <i data-icon="download" class="w-4 h-4"></i>
          <span>Not here? Import from BoardGameGeek</span>
        </button>

        <div id="add-games-list-host">${this._renderBody()}</div>
        <div id="add-games-more-host">${this._renderMore()}</div>
      `;
      this.refreshIcons();
      this._armInfinite();
    }

    _renderToggle() {
      return `
        <div class="spoke-toggle spoke-toggle--${SHELVES.length}" role="tablist"
             aria-label="Where added games go">
          ${SHELVES.map((s) => `
            <button class="spoke-toggle__pill ${this._shelf === s.id ? "is-active" : ""}"
                    role="tab" aria-selected="${this._shelf === s.id}"
                    data-shelf-pill="${s.id}"
                    onclick="window.addGamesView._setShelf('${s.id}')">
              <span class="spoke-toggle__label">${escapeHtml(s.label)}</span>
            </button>
          `).join("")}
        </div>
      `;
    }

    _countLabel() {
      if (!this._loadedOnce) return "";
      const n = this._total;
      const noun = `game${n === 1 ? "" : "s"}`;
      return this._query ? `${n} ${noun} match` : `${n} ${noun}`;
    }

    _renderBody() {
      if (this._error) {
        return `
          <div class="alert alert-error text-sm catalog-error">
            <span>${escapeHtml(this._error)}</span>
            <button class="btn btn-ghost btn-sm" onclick="window.addGamesView._load({reset:true})">Retry</button>
          </div>`;
      }
      // Never an empty state while the first page is still in the air — a
      // reset clears the list BEFORE the request goes out.
      if (this._games.length === 0 && (this._loading || !this._loadedOnce)) {
        return `<div class="profile-loading">${window.buddyLoader({ size: 88, label: "Loading the library…" })}</div>`;
      }
      if (this._games.length === 0) {
        return `<div class="profile-empty">${
          this._query
            ? `No games match “${escapeHtml(this._query)}”. Try importing it from BoardGameGeek.`
            : "The game library is empty — import a game from BoardGameGeek to start it off."
        }</div>`;
      }
      return `<ul class="catalog-list">${this._games.map((g) => this._renderRow(g)).join("")}</ul>`;
    }

    /**
     * One catalog row: the canonical Game tile in its row variant, plus the
     * quick action beside it. The tile's own status corner is off — it opens
     * the status sheet, which is the slow path this screen exists to replace,
     * and two controls saying "collection" on one 44px row is one too many.
     */
    _renderRow(game) {
      const id = game.id || "";
      return `
        <li class="catalog-row" data-catalog-row="${escapeAttr(id)}">
          ${window.renderGamePolaroid(game, {
            variant: "row",
            showStatus: false,
            // jsStr escapes the JS-string layer, escapeAttr the HTML one — a
            // bare " in a game name would otherwise close the onclick attribute
            // (mirrors ui/status-tag.js).
            clickHandler: escapeAttr(`window.router.go('game-detail',{gameId:'${jsStr(id)}',gameName:'${jsStr(game.name || "")}'})`),
          })}
          <span class="catalog-row__slot" data-catalog-slot="${escapeAttr(id)}"
                data-state="${escapeAttr(this._rowState(id))}">${this._renderSlot(game)}</span>
        </li>
      `;
    }

    /**
     * Everything about a row that depends on the viewer: the "on your other
     * shelf" note and the add/remove button. Kept in its own host so a status
     * change repaints ~60 bytes instead of the whole row (which would also
     * swap the tile's artwork out and back for no reason).
     */
    _renderSlot(game) {
      if (this._mapPending) return "";
      const id = game.id || "";
      const s = shelfOf(this._shelf);
      const status = this._statusMap[id] || null;
      const on = status === this._shelf;
      const busy = this._pending.has(id);
      const name = game.name || "this game";

      // Only worth saying when it differs from what the button reports: on the
      // Collection tab a wishlisted game is a one-tap move, and "Played" is
      // derived from logged plays, so the row explains why it isn't a "+".
      const other = (!on && status)
        ? `<span class="catalog-row__note">${escapeHtml(status === "played" ? "Played" : shelfOf(status).label)}</span>`
        : "";

      const label = on
        ? `Remove ${name} from your ${s.noun}`
        : `Add ${name} to your ${s.noun}`;
      return `
        ${other}
        <button type="button"
                class="catalog-row__action ${on ? "is-on" : ""}"
                data-catalog-add="${escapeAttr(id)}"
                ${busy ? 'aria-busy="true"' : ""}
                aria-pressed="${on}"
                title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">
          <i data-icon="${on ? "check" : "plus"}" class="w-4 h-4"></i>
        </button>
      `;
    }

    /**
     * Everything the slot's markup is derived from, as one string. Written to
     * the host as `data-state` so _syncRows can skip the rows a change didn't
     * touch — a single tap otherwise rewrites every row on screen.
     */
    _rowState(gameId) {
      if (this._mapPending) return "pending-map";
      return [
        this._shelf,
        this._statusMap[gameId] || "",
        this._pending.has(gameId) ? "busy" : "",
      ].join("|");
    }

    /** Repaint only the row slots whose state actually changed. */
    _syncRows() {
      const hosts = this.container.querySelectorAll("[data-catalog-slot]");
      const byId = new Map(this._games.map((g) => [g.id, g]));
      for (const host of hosts) {
        const id = host.getAttribute("data-catalog-slot");
        const next = this._rowState(id);
        if (host.getAttribute("data-state") === next) continue;
        const game = byId.get(id);
        if (!game) continue;
        host.setAttribute("data-state", next);
        host.innerHTML = this._renderSlot(game);
        // The button is written as <i data-icon> and stays an empty <i> until
        // BgbIcons hydrates it (.claude/rules/mobile-web.md §4).
        this.refreshIcons(host);
      }
    }

    _renderMore() {
      if (this._error) return "";
      return window.InfiniteScroll.renderFooter({
        id: "add-games-scroll-sentinel",
        hasMore: this._hasMore(),
        loading: this._loadingMore,
        error: this._moreError,
        onRetry: "window.addGamesView._retryMore()",
        // Only worth saying once the list ran past a page; on a short library
        // the end of the list is self-evident.
        endLabel: this._games.length > PER_PAGE ? `That's all ${this._countLabel()}.` : "",
      });
    }

    /** The reveal-a-batch path: two subtree writes, no shell teardown. */
    _paintList() {
      const list = this.container.querySelector("#add-games-list-host");
      if (!list) { this._renderShell(); return; }
      list.innerHTML = this._renderBody();
      this.refreshIcons(list);
      this._paintMore();
    }

    _paintMore() {
      const more = this.container.querySelector("#add-games-more-host");
      if (!more) return;
      more.innerHTML = this._renderMore();
      this.refreshIcons(more);
      this._armInfinite();
    }

    _paintCount() {
      const el = this.container.querySelector("#add-games-count");
      if (el) el.textContent = this._countLabel();
    }

    /** Pills are a fixed pair, so this only ever toggles a class. */
    _paintToggle() {
      for (const el of this.container.querySelectorAll("[data-shelf-pill]")) {
        const on = el.getAttribute("data-shelf-pill") === this._shelf;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-selected", String(on));
      }
    }

    /**
     * Re-point the sentinel after every paint — see ui/infinite-scroll.js on
     * why re-observing is what keeps the list moving rather than a leak.
     * Resolves to null when the list is finished, and observe(null) is how the
     * observer is stood down.
     */
    _armInfinite() {
      const host = this.container;
      this._infinite.observe(host && host.querySelector("#add-games-scroll-sentinel"));
    }

    _scrollToListTop() {
      const list = this.container && this.container.querySelector("#add-games-list-host");
      if (!list) return;
      const top = list.getBoundingClientRect().top + window.scrollY;
      // :root carries scroll-padding-top, so block:"start" clears the pinned
      // header without this having to know how tall it is.
      if (window.scrollY > top) list.scrollIntoView({ block: "start" });
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    _back() {
      // Reachable only from the two spokes, so back names a destination; the
      // fallback covers a cold deep link straight to /games/add.
      window.router.back(shelfOf(this._shelf).route);
    }

    /**
     * Switching shelves costs no I/O: the catalog does not depend on the
     * viewer, so only the buttons change. The URL follows so a refresh (or a
     * share) lands on the shelf the user was actually filling.
     */
    _setShelf(id) {
      if (this._shelf === id) return;
      this._shelf = shelfOf(id).id;
      this._paintToggle();
      this._syncRows();
      const back = this.container.querySelector(".spoke-head__back");
      if (back) back.setAttribute("aria-label", `Back to your ${shelfOf(this._shelf).noun}`);
      window.router.replaceUrl("add-games", { status: this._shelf });
    }

    _onSearchInput(value) {
      this._query = (value || "").trim();
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        if (!this._mounted) return;
        // A narrowed list starts at its head — leaving a deep scroll window
        // over fresh results drops the user into rows they never scrolled to.
        this._scrollToListTop();
        this._load({ reset: true });
      }, SEARCH_DEBOUNCE_MS);
    }

    /**
     * The escape hatch: a game BgB has never imported cannot appear in a
     * catalog scroll by definition. AddGameModal's finder already carries the
     * BGG search and import, and adds the result to the shelf on pick — so an
     * import lands the same way a row tap does, and the catalog it just grew
     * is re-read.
     */
    _openBggImport() {
      window.AddGameModal.open({
        status: this._shelf,
        title: "Import from BoardGameGeek",
        hint: "Search BoardGameGeek for a game BoardgameBuddy doesn't have yet — importing it adds it here too.",
        onAdded: () => {
          // The import changed the catalog, which no collection mutation
          // invalidates. Drop every cached page and re-read from the top.
          if (window.bgbCache) window.bgbCache.clear(CATALOG_NS);
          this._load({ reset: true });
        },
      });
    }
  }

  window.AddGamesView = AddGamesView;
})();
