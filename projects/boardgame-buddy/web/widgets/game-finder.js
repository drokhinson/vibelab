// widgets/game-finder.js — Reusable game-picker combo (input + dropdown).
//
// Searches the BgB catalog, offers a BoardGameGeek fallback when the catalog
// has no hits, and imports a BGG result on tap via Game.importBgg(). Picking a
// result fires the caller-supplied onPick callback — the widget itself never
// mutates collection/session state.
//
// A keystroke is answered on the device. The whole base-game catalog is on
// the phone as a compact index (domain/catalog-index.js, warmed from an idle
// callback after login and refreshed every ten minutes), so typing is a
// synchronous substring match with no debounce and no request behind it —
// which is the difference between a picker that feels like a text filter and
// one that feels like a form submit. The list is patched in place
// (ui/dom-patch.js), so a row that survives a keystroke keeps its <img>.
//
// /search is the FALLBACK, taken only while the index is not on the device
// yet (first visit, a cleared cache) or when the catalog has outgrown the
// index's cap. On that path every keystroke still paints synchronously first
// — from an exact cached answer, a cached answer to a shorter query this one
// extends, or the device's own warmed library — and /search refines it.
//
// An index row carries what a result row PAINTS and no more (see the module
// header in catalog-index.js), so a pick from it hydrates the full game
// before handing it on — from the device when the game is one of the user's
// own, from GET /games/{id} otherwise. See _pickById.
//
// Expansions never appear here: /search excludes them from every source
// (library, DB, BGG). They're added through a base game's expansion
// section — see widgets/import-expansions-modal.js.
// Used by widgets/game-search-sheet.js, which mounts it inside a bottom
// sheet — reached from views/play-flow-view.js (Gather: pick
// the game for a session) and views/import-wizard-view.js (name an imported
// play's game).
//
// NOT used by widgets/bgg-import-sheet.js, which is the BoardGameGeek import.
// That sheet searches BGG on an explicit Search rather than on every keystroke
// (so the field can be blurred and the keyboard dropped before results land),
// and it separates importing from shelving — neither of which is a shape this
// widget has.
//
// Each instance owns a unique input + dropdown DOM id so two finders can
// coexist on the same page if needed.

// @ts-check

(function () {
  let _seq = 0;

  // FALLBACK PATH ONLY (no catalog index on the device): how long after the
  // last keystroke the network search fires. The dropdown is never empty
  // while it waits — every keystroke repaints synchronously from cached
  // results + the device's own library first (see _paintProvisional) — so
  // this budget only delays the refinement.
  const SEARCH_DEBOUNCE_MS = 180;

  // How many BGG hits this dropdown will show. See _runBgg.
  const BGG_DROPDOWN_MAX = 25;

  // Fallback path only: below this, /search is not called at all.
  //
  // The catalog ILIKE '%q%' is served by a pg_trgm GIN index, and pg_trgm has
  // nothing to match on under three characters — so a 1- or 2-character query
  // is the single most expensive shape the endpoint can be asked for (a seq
  // scan of the whole catalog plus the collection join) in exchange for an
  // alphabetical slice of hundreds of matches that nobody wants. Those two
  // keystrokes are served from the device instead.
  const MIN_REMOTE_QUERY_LEN = 3;

  // Rows a query paints, from the index or (fallback) before the server
  // answers. Matches /search's default limit so every list is the same length.
  const PROVISIONAL_LIMIT = 20;

  // What an empty catalog answer says. The BGG footer under it is the way on.
  const NO_MATCH_HTML =
    `<li class="game-finder-dropdown__hint" data-morph-key="hint">No matches in your library.</li>`;

  // The device pool (recents + every warmed game bundle) is rebuilt at most
  // this often, so a fast typer walks an already-built index instead of
  // re-reading the cache on every keystroke. Short enough that bundles warmed
  // by the background loader show up while the sheet is still open.
  const DEVICE_POOL_TTL_MS = 5000;

  /**
   * @typedef {Object} GameFinderOpts
   * @property {(game: any, ctx: PickCtx) => (void|Promise<void|RefusalResult>)} onPick
   *   Caller-supplied handler. Return `{ refuse, reason }` to keep the
   *   dropdown open with the row showing `reason`; return undefined / a
   *   resolved void Promise to let the widget close the dropdown.
   * @property {(err: Error) => void} [onError]
   * @property {string} [placeholder]
   * @property {boolean} [includeRecentlyPlayed]  Default true.
   */

  /** @typedef {{ source: "library"|"bgg"|"recent", isExpansion: boolean, dropdownItemEl: Element|null }} PickCtx */
  /** @typedef {{ refuse?: boolean, reason?: string }} RefusalResult */

  class GameFinder {
    /** @param {GameFinderOpts} opts */
    constructor(opts) {
      if (!opts || typeof opts.onPick !== "function") {
        throw new Error("GameFinder: onPick is required");
      }
      this._opts = opts;
      this._id = ++_seq;
      this.inputId = `game-finder-input-${this._id}`;
      this.dropdownId = `game-finder-dropdown-${this._id}`;
      this._container = null;
      this._recentGames = null;     // null = not loaded yet; [] = loaded, empty
      this._recentGamesPromise = null; // in-flight load, single-flight + retry-on-error
      this._queryToken = 0;         // increments on every search; stale responses are dropped
      this._searchTimer = null;
      this._searchAbort = null;     // AbortController for the in-flight /search
      this._devicePoolRows = null;  // memoized {game, lower}[] — see _devicePool
      this._devicePoolAt = 0;
      this._bggMode = false;
      this._gameById = new Map();   // gameId → game object (so _pickById has the row data)
      this._outsideHandler = this._onOutsideClick.bind(this);
      this._docHandlerBound = false;
      this._offlineNotified = false; // see _notifyOfflineOnce
      this._indexKicked = false;     // CatalogIndex.ensure() once per mount
    }

    mount(containerEl) {
      if (!containerEl) return;
      // Idempotent: if already mounted in this container, no-op so the
      // play-flow's 2s lobby-poll re-render doesn't tear-down/re-create.
      if (this._container === containerEl
          && containerEl.querySelector(`#${this.inputId}`)) {
        return;
      }
      this._container = containerEl;
      const placeholder = escapeAttr(this._opts.placeholder || "Search for a game…");
      containerEl.innerHTML = `
        <div class="game-finder game-finder--inline" data-search-host>
          <i data-icon="search" class="w-4 h-4 game-finder__icon"></i>
          <input id="${this.inputId}"
                 class="input input-bordered game-finder__input"
                 placeholder="${placeholder}"
                 autocomplete="off" autocapitalize="off" autocorrect="off" />
          ${window.BgbSearchField.clearButton()}
          <ul id="${this.dropdownId}" class="game-finder-dropdown hidden"
              onmousedown="event.preventDefault()"></ul>
        </div>
      `;
      window.BgbIcons.render(containerEl);
      // One delegated click handler for the life of the mount. The list is
      // patched in place from here on, never rebuilt, so this is bound once.
      const dd = document.getElementById(this.dropdownId);
      if (dd) this._wireRowClicks(dd);

      const input = document.getElementById(this.inputId);
      if (input) {
        input.addEventListener("input", (e) => {
          const target = /** @type {HTMLInputElement} */ (e.target);
          this._onInput(target.value);
        });
        input.addEventListener("focus", () => this._open());
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            this._close();
            input.blur();
          }
        });
      }
      if (!this._docHandlerBound) {
        document.addEventListener("click", this._outsideHandler, true);
        this._docHandlerBound = true;
      }
      // Synchronously pick up the bootstrap-seeded recents so a tap-and-focus
      // before the microtask flush still renders the list. The async load
      // below covers the cold-cache case (no bootstrap seed) and refreshes
      // when the entry has fallen into the SWR stale window.
      if (this._opts.includeRecentlyPlayed !== false && window.bgbCache) {
        // peek() rather than get(), always: get() only serves the 24h fresh
        // window, and a host in a cabin for a weekend would find their own
        // recents gone. peek() serves the full 7d stale window, which is
        // exactly what bootstrap's hostSeed TTL pair was sized for — and
        // _ensureRecentGamesLoad() below refreshes it a frame later anyway,
        // so the wider window costs nothing when there IS a connection. This
        // used to happen only when BgbNet said offline, which meant the seed
        // was narrower precisely when it was cheapest to widen.
        const seeded = window.bgbCache.peek("game.recent", "self");
        if (Array.isArray(seeded)) this._recentGames = seeded;
      }
      // Eagerly start loading recently-played so the dropdown is ready
      // before the user focuses. Failure leaves _recentGames as null so
      // the next focus retries instead of caching an empty list forever.
      this._ensureRecentGamesLoad();
      this._kickIndex();
    }

    /**
     * Make sure the catalog index is on its way. Normally a no-op — init.js
     * warms it from an idle callback after login — but a cold cache or a
     * failed warm-up would otherwise leave this mount on the /search path
     * for its whole life. When it lands with a query already in the box,
     * that query is re-answered from the index, superseding any request the
     * fallback path has in the air.
     */
    _kickIndex() {
      if (this._indexKicked || !window.CatalogIndex) return;
      this._indexKicked = true;
      const wasReady = !!this._indexReady();
      let p;
      try { p = window.CatalogIndex.ensure(); } catch (_) { return; }
      if (!p || typeof p.then !== "function" || wasReady) return;
      p.then(() => {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
        if (!input || this._bggMode) return;
        const dd = document.getElementById(this.dropdownId);
        if (!dd || dd.classList.contains("hidden")) return;
        if ((input.value || "").trim()) this._onInput(input.value);
      }).catch(() => {});
    }

    /**
     * Is the on-device catalog index the authority right now?
     * @returns {{rows: number, truncated: boolean}|null}
     */
    _indexReady() {
      if (!window.CatalogIndex || !window.CatalogIndex.peek) return null;
      const idx = window.CatalogIndex.peek();
      return idx && !idx.truncated ? idx : null;
    }

    /**
     * The index's answer to `q`: substring matches, ranked, the viewer's own
     * games first within a rank (see CatalogIndex.search).
     * @param {string} q
     * @returns {Array<Object>}
     */
    _indexMatches(q) {
      const statusMap = (window.Collection && window.Collection.cachedStatusMap)
        ? window.Collection.cachedStatusMap() : null;
      return window.CatalogIndex.search(q, { limit: PROVISIONAL_LIMIT, statusMap });
    }

    unmount() {
      clearTimeout(this._searchTimer);
      this._supersede(); // invalidate AND abort any in-flight search
      this._devicePoolRows = null;
      this._indexKicked = false;
      if (this._docHandlerBound) {
        document.removeEventListener("click", this._outsideHandler, true);
        this._docHandlerBound = false;
      }
      if (this._container) {
        this._container.innerHTML = "";
        this._container = null;
      }
      this._gameById.clear();
    }

    /**
     * Put the caret in the field. Only ever called from a user gesture — an
     * overlay must not call this on open (.claude/rules/overlays.md §5).
     */
    focus() {
      const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
      if (input) input.focus();
    }

    /**
     * Open the results list — the recently-played seed on an empty query —
     * WITHOUT taking focus, so a sheet can land showing something useful
     * without a software keyboard covering it. Tapping the field is still
     * what raises the keyboard.
     */
    showList() {
      this._open({ requireFocus: false });
    }

    reset() {
      this._bggMode = false;
      this._supersede();
      const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
      if (input) {
        input.value = "";
        // Emptying the box by hand leaves the shared × up, since nothing
        // dispatched an `input` event. Re-derive it rather than dispatching
        // one — a synthetic keystroke here would re-open the dropdown that
        // _close() is about to shut.
        window.BgbSearchField.sync(input.closest("[data-search-host]") || undefined);
      }
      this._close();
    }

    // ── Internal ──────────────────────────────────────────────────────────

    // Every keystroke paints synchronously. With the catalog index on the
    // device that paint IS the answer — no request follows. Without it (the
    // fallback path) the paint comes from what the device knows and /search
    // refines it after a debounce; even then the network is only ever the
    // refinement pass, never the thing the user waits on before seeing a
    // list.
    _onInput(value) {
      clearTimeout(this._searchTimer);
      // The previous keystroke's answer is not wanted any more — drop the
      // response AND the request, so a superseded search stops competing for
      // the connection the current one needs.
      this._supersede();
      this._bggMode = false;
      const q = (value || "").trim();

      // An empty query resolves with no request at all.
      if (!q) {
        this._renderDropdown(q);
        return;
      }

      // The whole catalog is on the device: answer from it and stop.
      if (this._indexReady()) {
        const dd = document.getElementById(this.dropdownId);
        if (dd) this._paintList(dd, this._indexMatches(q), q, { emptyHtml: NO_MATCH_HTML });
        return;
      }
      this._kickIndex();

      // Fallback, instant path: a query the user already searched is served
      // from cache with no debounce and no loading flash (backspace / re-type
      // feel live).
      const cached = (window.Game && window.Game.cachedSearch)
        ? window.Game.cachedSearch(q) : null;
      if (cached) {
        const dd = document.getElementById(this.dropdownId);
        if (dd) {
          dd.classList.remove("game-finder-dropdown--loading");
          this._renderResults(dd, cached, q);
        }
        return;
      }

      const willFetch = q.length >= MIN_REMOTE_QUERY_LEN;
      this._paintProvisional(q, { willFetch });
      if (!willFetch) return;
      // Debounce only the network call — the list above is already on screen.
      this._searchTimer = setTimeout(() => this._renderDropdown(q), SEARCH_DEBOUNCE_MS);
    }

    /** Invalidate the in-flight search: drop its response and abort it. */
    _supersede() {
      this._queryToken++;
      if (this._searchAbort) {
        try { this._searchAbort.abort(); } catch (_) {}
        this._searchAbort = null;
      }
    }

    _ensureRecentGamesLoad() {
      if (this._opts.includeRecentlyPlayed === false) return null;
      if (this._recentGames !== null) return null;
      if (this._recentGamesPromise) return this._recentGamesPromise;
      this._recentGamesPromise = (async () => {
        try {
          const res = await window.Game.recentlyPlayed(6);
          this._recentGames = Array.isArray(res) ? res : [];
        } catch (_) {
          // Leave _recentGames null so the next focus retries.
        } finally {
          this._recentGamesPromise = null;
        }
      })();
      return this._recentGamesPromise;
    }

    /** @param {{ requireFocus?: boolean }} [opts] */
    async _open(opts) {
      const requireFocus = !opts || opts.requireFocus !== false;
      // A fresh open is a fresh picking session, so the offline line is worth
      // saying again — the user may well have moved rooms since the last one.
      this._offlineNotified = false;
      // If recents aren't loaded yet, show a synchronous loading hint so
      // the user sees the dropdown immediately, then await the load and
      // render the real list.
      const needsLoad =
        this._opts.includeRecentlyPlayed !== false && this._recentGames === null;
      if (needsLoad) {
        const dd = document.getElementById(this.dropdownId);
        if (dd) {
          dd.innerHTML = `<li class="game-finder-dropdown__hint">Loading recent games…</li>`;
          this._show(dd);
        }
        const p = this._ensureRecentGamesLoad();
        if (p) {
          try { await p; } catch (_) {}
        }
        // A focus-driven open belongs to the field: if focus left while the
        // recents were loading, don't pop a list back up behind the user. A
        // seeded open (showList) has no focus to test, so it stays valid for
        // as long as the dropdown it painted the hint into is still showing —
        // a tap outside, a pick or a close will have hidden it by then.
        const live = document.getElementById(this.dropdownId);
        if (requireFocus) {
          const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
          if (!input || document.activeElement !== input) return;
        } else if (!live || live.classList.contains("hidden")) {
          return;
        }
      }
      const input = /** @type {HTMLInputElement|null} */ (document.getElementById(this.inputId));
      const q = input ? (input.value || "").trim() : "";
      this._renderDropdown(q);
    }

    // The list is an ordinary block inside a sheet panel already sized to the
    // visible viewport, so revealing it needs no fit pass.
    _show(dd) {
      dd.classList.remove("hidden");
    }

    _close() {
      const dd = document.getElementById(this.dropdownId);
      if (dd) {
        dd.classList.add("hidden");
        dd.classList.remove("game-finder-dropdown--loading");
        dd.innerHTML = "";
      }
    }

    _onOutsideClick(e) {
      if (!this._container) return;
      if (this._container.contains(e.target)) return;
      this._close();
    }

    async _renderDropdown(query) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd) return;
      const q = (query || "").trim();
      this._supersede();
      const token = this._queryToken;

      // Empty query → recently-played seed (or hint). No BGG footer (nothing
      // to search for yet).
      if (!q) {
        const list = (this._opts.includeRecentlyPlayed !== false && this._recentGames) || [];
        this._paintList(dd, list, q, {
          source: "recent",
          header: list.length ? "Recently played" : null,
          emptyHtml: `<li class="game-finder-dropdown__hint" data-morph-key="hint">Type a game name to search.</li>`,
          footer: false,
        });
        return;
      }

      // The catalog index is the whole answer — same branch _onInput takes;
      // repeated here for the other entry point (focus with a query in the
      // box).
      if (this._indexReady()) {
        this._paintList(dd, this._indexMatches(q), q, { emptyHtml: NO_MATCH_HTML });
        return;
      }
      this._kickIndex();

      // Fallback. Cache hit → render instantly, no loading state, no network
      // wait.
      const cached = (window.Game && window.Game.cachedSearch)
        ? window.Game.cachedSearch(q) : null;
      if (cached) {
        dd.classList.remove("game-finder-dropdown--loading");
        this._renderResults(dd, cached, q);
        return;
      }

      // Cache miss → paint what the device already knows, then refine over the
      // network. _onInput has usually painted this already; repeating it here
      // covers the other entry point (focus with a query still in the box).
      this._paintProvisional(q, { willFetch: q.length >= MIN_REMOTE_QUERY_LEN });
      // Too short for the trigram index to help — the device pool above is the
      // whole answer until another character arrives.
      if (q.length < MIN_REMOTE_QUERY_LEN) return;

      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      this._searchAbort = ctl;
      let data;
      try {
        data = await window.Game.search(q, ctl ? { signal: ctl.signal } : undefined);
      } catch (e) {
        if (this._searchAbort === ctl) this._searchAbort = null;
        // An abort is this widget superseding itself, not a failure to report.
        if (token !== this._queryToken || (e && e.aborted)) return;
        dd.classList.remove("game-finder-dropdown--loading");
        if (isOfflineError(e)) {
          // /search is server-side, but the device pool is not — and it is
          // overwhelmingly what a host on Gather is reaching for. Fall back to
          // it rather than replacing real, tappable results with "Search
          // failed" to report that there are no MORE of them.
          this._renderOfflineResults(dd, this._deviceMatches(q));
          this._notifyOfflineOnce();
          return;
        }
        this._patch(dd,
          `<li class="game-finder-dropdown__hint" data-morph-key="hint">Search failed. Try again.</li>` +
          this._bggFooter(q));
        if (this._opts.onError) this._opts.onError(e);
        return;
      }
      if (this._searchAbort === ctl) this._searchAbort = null;
      if (token !== this._queryToken) return;
      dd.classList.remove("game-finder-dropdown--loading");
      this._renderResults(dd, data, q);
    }

    /**
     * Paint the answer the device can give right now, before any request.
     *
     * Two sources, both free: results already cached for a shorter query that
     * `q` extends (Game.cachedSearchPrefix — typing "catan" asks five separate
     * questions whose answers all live inside the first one), and the device
     * pool of the viewer's own games (_deviceMatches). Neither is authoritative
     * — both are capped lists — so when a request is on its way the rows are
     * flagged as refreshing and get replaced by _renderResults.
     *
     * @param {string} q
     * @param {{willFetch: boolean}} opts
     */
    _paintProvisional(q, { willFetch }) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd) return;
      const games = this._provisionalMatches(q);
      const emptyHtml = willFetch
        ? `<li class="game-finder-dropdown__loading-row" data-morph-key="loading">
             <span class="game-finder-spinner" aria-hidden="true"></span>
             <span>Searching…</span>
           </li>`
        // Nothing on the device matches and we deliberately aren't asking the
        // server yet — say which of those it is rather than "no matches".
        : `<li class="game-finder-dropdown__hint" data-morph-key="hint">Keep typing to search the full library.</li>`;
      // The dimmed/refreshing treatment only reads as "these are being
      // replaced" when there is something to dim.
      this._paintList(dd, games, q, { emptyHtml, loading: !!willFetch });
    }

    /**
     * Provisional match list: cached-prefix hits (which carry the server's own
     * collection-first ranking, and can include catalog games the device never
     * owned) followed by device matches not already in it.
     *
     * @param {string} q
     * @returns {Array<Object>}
     */
    _provisionalMatches(q) {
      const byId = new Map();
      const add = (g) => {
        if (!g || !g.id || byId.has(g.id) || g.is_expansion) return;
        if (byId.size >= PROVISIONAL_LIMIT) return;
        byId.set(g.id, g);
      };
      if (window.Game && window.Game.cachedSearchPrefix) {
        window.Game.cachedSearchPrefix(q).forEach(add);
      }
      this._deviceMatches(q).forEach(add);
      return Array.from(byId.values());
    }

    // Render /search results + the always-visible sticky BGG footer. Shared
    // by the fallback path's cache-hit and network-response branches.
    _renderResults(dd, data, q) {
      const hits = (data && data.results) || [];
      const games = [];
      hits.forEach((h) => { if (h && h.game) games.push(h.game); });
      this._paintList(dd, games, q, { emptyHtml: NO_MATCH_HTML });
    }

    /**
     * The one paint every list goes through.
     *
     * Builds the rows and patches them INTO the dropdown (ui/dom-patch.js)
     * rather than replacing its innerHTML: every <li> is keyed by game id, so
     * a keystroke that keeps a row keeps its node — its <img> does not
     * re-decode, :active is not lost under a finger, and no icon is
     * re-hydrated that was already there. overlays.md §6.
     *
     * @param {Element} dd
     * @param {Array<Object>} games
     * @param {string} q
     * @param {{ source?: "library"|"recent", header?: string|null,
     *           emptyHtml?: string, footer?: boolean, loading?: boolean }} [opts]
     *   `emptyHtml` is one keyed <li> for the no-rows case. `footer` (default
     *   true) appends the BGG footer when there is a query. `loading` dims the
     *   rows as "about to be replaced" — meaningful only when there are rows.
     */
    _paintList(dd, games, q, opts) {
      const o = opts || {};
      this._gameById.clear();
      games.forEach((g) => { if (g && g.id) this._gameById.set(g.id, g); });
      let html = "";
      if (o.header) {
        html += `<li class="game-finder-dropdown__header" data-morph-key="header">${escapeHtml(o.header)}</li>`;
      }
      if (games.length) {
        html += games.map((g) => this._renderRow(g, o.source || "library")).join("");
      } else if (o.emptyHtml) {
        html += o.emptyHtml;
      }
      if (o.footer !== false && q) html += this._bggFooter(q);
      dd.classList.toggle("game-finder-dropdown--loading", !!o.loading && games.length > 0);
      this._patch(dd, html);
      this._show(dd);
    }

    /**
     * Patch the dropdown's children towards `html`. The morph hydrates icons
     * on the new tree itself; the innerHTML branch is only for a page that
     * loaded without ui/dom-patch.js and needs the pass run by hand.
     * @param {Element} dd @param {string} html
     */
    _patch(dd, html) {
      if (window.BgbDomPatch && window.BgbDomPatch.morph) {
        window.BgbDomPatch.morph(dd, html);
        return;
      }
      dd.innerHTML = html;
      window.BgbIcons.render(dd);
    }

    /**
     * Every game the device can offer with no server, name-ordered, each row
     * carrying its lower-cased name so a keystroke is one indexOf per entry.
     *
     * Two sources, both already on disk:
     *   • `game.recent:self` — the host-flow seed bootstrap warms (24h/7d).
     *   • `game.bundle:*`    — one entry per OWNED game, warmed by
     *     Bootstrap.warmGameBundles() from an idle callback after login.
     *
     * That second one is the real library: it's the user's whole collection,
     * which is overwhelmingly what a group is playing — in a cabin with no
     * signal, and equally at a table with plenty, which is why this pool backs
     * every first paint and is also what a failed /search falls back to rather
     * than a branch taken before the request. Read through
     * peek() so entries past their fresh window still count — a stale name and
     * thumbnail are fine, and the game row itself is immutable after BGG
     * import anyway.
     *
     * Memoized for DEVICE_POOL_TTL_MS: rebuilding walks up to 250 cache
     * entries, which is wasted work at typing speed but must still pick up
     * bundles the background warm-up finishes while the sheet is open.
     *
     * @returns {Array<{game: Object, lower: string}>}
     */
    _devicePool() {
      const now = Date.now();
      if (this._devicePoolRows && now - this._devicePoolAt < DEVICE_POOL_TTL_MS) {
        return this._devicePoolRows;
      }
      const cache = window.bgbCache;
      const rows = [];
      if (cache) {
        const seen = new Set();
        const consider = (g) => {
          if (!g || !g.id || seen.has(g.id) || !g.name) return;
          // Expansions are excluded from /search on every source; this pool
          // has to agree or the picker would start offering them here and
          // nowhere else. They attach via the Expansions card instead.
          if (g.is_expansion) return;
          seen.add(g.id);
          rows.push({ game: g, lower: g.name.toLowerCase() });
        };
        const recent = cache.peek("game.recent", "self");
        if (Array.isArray(recent)) recent.forEach(consider);
        for (const gameId of cache.keys("game.bundle")) {
          const bundle = cache.peek("game.bundle", gameId);
          if (bundle && bundle.game) consider(bundle.game);
        }
        rows.sort((a, b) => a.lower.localeCompare(b.lower));
      }
      this._devicePoolRows = rows;
      this._devicePoolAt = now;
      return rows;
    }

    /**
     * Device-pool games matching `q`, prefix matches first.
     *
     * Matching stays case-insensitive substring to agree with the backend's
     * ILIKE '%q%'; the prefix-first split is ranking only, so "cat" leads with
     * Catan rather than whatever sorts first alphabetically.
     *
     * @param {string} q
     * @returns {Array<Object>} GameSummary-ish rows
     */
    _deviceMatches(q) {
      const needle = (q || "").toLowerCase();
      if (!needle) return [];
      const starts = [];
      const contains = [];
      for (const row of this._devicePool()) {
        const at = row.lower.indexOf(needle);
        if (at === 0) starts.push(row.game);
        else if (at > 0) contains.push(row.game);
      }
      return starts.concat(contains);
    }

    /**
     * Offline dropdown: matches only, no BGG footer.
     *
     * The empty state names the constraint rather than saying "no matches" —
     * POST /plays requires a real game_id, so a game that was never cached
     * genuinely cannot be logged until the app is back online, and a host
     * staring at an empty list deserves to know that's why.
     */
    /**
     * Say it once per open, not once per keystroke.
     *
     * Every character types a new search, so the ordinary "the action failed,
     * toast it" rule would fire a toast per keystroke here. The list itself
     * carries the standing explanation ("On this device"); this is the one
     * line that names WHY the rest of the library isn't in it, and it only
     * needs saying once while the picker is open.
     */
    _notifyOfflineOnce() {
      if (this._offlineNotified) return;
      this._offlineNotified = true;
      if (typeof showToast === "function") {
        showToast("You're offline — searching the full library needs a connection.", "error");
      }
    }

    _renderOfflineResults(dd, games) {
      this._paintList(dd, games, "", {
        header: games.length ? "On this device" : null,
        emptyHtml: `<li class="game-finder-dropdown__hint" data-morph-key="hint">
             No match on this device, and searching the full library needs a
             connection. You can still pick anything already saved here — your
             collection and recent plays.
           </li>`,
        footer: false,
      });
    }

    // Short, sticky "Search BoardGameGeek" action pinned to the bottom of the
    // dropdown — always offered whenever there's a query, even when the
    // library already has matches, so BGG is one tap away and never buried.
    _bggFooter(q) {
      return `
        <li class="game-finder-dropdown__bgg-footer" data-morph-key="bgg-footer">
          <button type="button" class="game-finder-bgg-btn"
                  data-finder-action="run-bgg" data-finder-query="${escapeAttr(q)}">
            <i data-icon="search" class="w-4 h-4"></i>
            <span>Search BoardGameGeek</span>
          </button>
        </li>`;
    }

    _renderRow(game, source) {
      const meta = [
        game.year_published,
        game.min_players
          ? `${game.min_players}${game.max_players && game.max_players !== game.min_players ? "–" + game.max_players : ""}P`
          : null,
        game.playing_time ? `${game.playing_time}m` : null,
      ].filter(Boolean).join(" · ");
      return `
        <li class="game-finder-dropdown-item" data-morph-key="${escapeAttr(game.id)}"
            data-finder-action="pick" data-finder-game-id="${escapeAttr(game.id)}"
            data-finder-source="${escapeAttr(source)}">
          ${game.thumbnail_url
            ? `<img class="game-finder-dropdown-item__thumb" src="${escapeAttr(game.thumbnail_url)}" alt="" loading="lazy" />`
            : `<div class="game-finder-dropdown-item__thumb game-finder-dropdown-item__thumb--placeholder"><i data-icon="dice-6"></i></div>`}
          <div class="game-finder-dropdown-item__body">
            <div class="game-finder-dropdown-item__name">${escapeHtml(game.name)}</div>
            ${meta ? `<div class="game-finder-dropdown-item__meta">${escapeHtml(meta)}</div>` : ""}
          </div>
        </li>
      `;
    }

    _wireRowClicks(dd) {
      // Single delegated listener, bound once at mount — picks/imports/run-bgg
      // all come through data-finder-action so we never inline onclicks, and
      // the list is patched in place so the handler never needs re-binding.
      dd.onclick = (e) => {
        const row = e.target.closest("[data-finder-action]");
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        const action = row.getAttribute("data-finder-action");
        if (action === "pick") {
          const id = row.getAttribute("data-finder-game-id");
          const source = /** @type {"library"|"recent"} */ (row.getAttribute("data-finder-source") || "library");
          this._pickById(id, source, row);
        } else if (action === "run-bgg") {
          const q = row.getAttribute("data-finder-query") || "";
          this._runBgg(q);
        } else if (action === "import-bgg") {
          const bggId = Number(row.getAttribute("data-finder-bgg-id"));
          const name = row.getAttribute("data-finder-bgg-name") || "";
          this._importBgg(bggId, name, row);
        }
      };
    }

    async _runBgg(q) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd) return;
      this._bggMode = true;
      const token = ++this._queryToken;
      dd.classList.remove("game-finder-dropdown--loading");
      dd.innerHTML =
        `<li class="game-finder-dropdown__loading-row">
           <span class="game-finder-spinner" aria-hidden="true"></span>
           <span>Searching BoardGameGeek…</span>
         </li>`;
      this._show(dd);

      let data;
      try {
        data = await window.Game.search(q, { includeBgg: true });
      } catch (e) {
        if (token !== this._queryToken) return;
        dd.innerHTML = `<li class="game-finder-dropdown__hint">BoardGameGeek search failed.</li>`;
        if (this._opts.onError) this._opts.onError(e);
        return;
      }
      if (token !== this._queryToken) return;

      const bgg = (data && data.bgg_results) || [];
      if (bgg.length === 0) {
        dd.innerHTML = `<li class="game-finder-dropdown__hint">No BoardGameGeek matches.</li>`;
        return;
      }
      // Capped for the dropdown only. /search now returns BGG's whole ranked
      // match set — hundreds of rows for a franchise name — which the import
      // sheet windows and scrolls. This is an escalation inside a picker: a
      // host is reaching for one specific game, and the answer is at the top
      // or it is not here.
      dd.innerHTML =
        `<li class="game-finder-dropdown__header">From BoardGameGeek</li>` +
        bgg.slice(0, BGG_DROPDOWN_MAX).map((hit) => `
          <li class="game-finder-dropdown-item game-finder-dropdown-item--bgg"
              data-finder-action="import-bgg"
              data-finder-bgg-id="${hit.bgg_id}"
              data-finder-bgg-name="${escapeAttr(hit.name)}"
              data-bgg-id="${hit.bgg_id}">
            <div class="game-finder-dropdown-item__thumb game-finder-dropdown-item__thumb--placeholder">
              <i data-icon="dice-6"></i>
            </div>
            <div class="game-finder-dropdown-item__body">
              <div class="game-finder-dropdown-item__name">${escapeHtml(hit.name)}</div>
              <div class="game-finder-dropdown-item__meta">
                ${hit.year_published || ""}${hit.already_in_db ? `${hit.year_published ? " · " : ""}In library` : ""}
              </div>
            </div>
            <button class="btn btn-ghost btn-sm game-finder-dropdown-item__action">
              ${hit.already_in_db ? "Pick" : "Import"}
            </button>
          </li>
        `).join("");
      window.BgbIcons.render(dd);
    }

    async _importBgg(bggId, name, rowEl) {
      const dd = document.getElementById(this.dropdownId);
      if (!dd || !rowEl) return;
      const setMeta = (text) => {
        const body = rowEl.querySelector(".game-finder-dropdown-item__body");
        if (!body) return;
        body.innerHTML = `
          <div class="game-finder-dropdown-item__name">${escapeHtml(name)}</div>
          <div class="game-finder-dropdown-item__meta">${escapeHtml(text)}</div>
        `;
      };
      setMeta("Importing from BoardGameGeek…");
      const action = rowEl.querySelector(".game-finder-dropdown-item__action");
      if (action) { action.disabled = true; action.textContent = "…"; }

      try {
        const game = await window.Game.importBgg(bggId);
        if (!document.getElementById(this.inputId)) return; // unmounted mid-import
        this._handlePick(game, { source: "bgg", isExpansion: !!(game && game.is_expansion), dropdownItemEl: rowEl });
      } catch (e) {
        if (!document.getElementById(this.inputId)) return;
        setMeta("Import failed. Try again.");
        if (action) { action.disabled = false; action.textContent = "Retry"; }
        if (this._opts.onError) this._opts.onError(e);
      }
    }

    async _pickById(gameId, source, rowEl) {
      if (!gameId) return;
      let game = this._gameById.get(gameId);
      if (!game && Array.isArray(this._recentGames)) {
        game = this._recentGames.find((g) => g.id === gameId);
      }
      if (game && game._partial) {
        game = await this._hydratePartial(game, rowEl);
        // Unmounted while the row was loading — the sheet is gone.
        if (!document.getElementById(this.inputId)) return;
      }
      if (!game) {
        try {
          game = await window.api.get(`/games/${gameId}`);
        } catch (_) { return; }
      }
      this._handlePick(game, {
        source: source || "library",
        isExpansion: !!(game && game.is_expansion),
        dropdownItemEl: rowEl || null,
      });
    }

    /**
     * Widen an index row into a full game before it is handed on.
     *
     * The device first: an owned game has its bundle warmed, and a recent one
     * is in the recents seed — both carry the full GameSummary and cost
     * nothing. Otherwise one GET /games/{id}, which game_routes caches for an
     * hour. On failure (offline, a stalled request) the partial row is picked
     * anyway: _applyGamePick tolerates a missing image and rulebook, and a
     * host who has just found their game should not be told "no" because a
     * detail fetch fell over.
     *
     * @param {Object} game the `_partial` row
     * @param {Element|null} rowEl
     * @returns {Promise<Object>}
     */
    async _hydratePartial(game, rowEl) {
      const cache = window.bgbCache;
      if (cache) {
        const bundle = cache.peek("game.bundle", game.id);
        if (bundle && bundle.game && bundle.game.id === game.id) return bundle.game;
      }
      if (Array.isArray(this._recentGames)) {
        const recent = this._recentGames.find((g) => g && g.id === game.id);
        if (recent) return recent;
      }
      const body = rowEl ? rowEl.querySelector(".game-finder-dropdown-item__body") : null;
      const before = body ? body.innerHTML : null;
      if (body) {
        body.innerHTML = `
          <div class="game-finder-dropdown-item__name">${escapeHtml(game.name)}</div>
          <div class="game-finder-dropdown-item__meta">Loading…</div>
        `;
      }
      try {
        const full = await window.api.get(`/games/${game.id}`);
        if (full && full.id === game.id) return full;
      } catch (_) {
        // fall through to the partial row
      }
      if (body && before != null && body.isConnected) body.innerHTML = before;
      return game;
    }

    async _handlePick(game, ctx) {
      if (!game || !game.id) return;
      let result;
      try {
        result = await this._opts.onPick(game, ctx);
      } catch (e) {
        if (this._opts.onError) this._opts.onError(e);
        return;
      }
      if (result && result.refuse) {
        // Caller refused the pick — leave dropdown open with the row in
        // an explanatory state.
        const row = ctx.dropdownItemEl;
        if (row) {
          const body = row.querySelector(".game-finder-dropdown-item__body");
          if (body) {
            body.innerHTML = `
              <div class="game-finder-dropdown-item__name">${escapeHtml(game.name)}</div>
              <div class="game-finder-dropdown-item__meta">${escapeHtml(result.reason || "Can't pick this game.")}</div>
            `;
          }
          const action = row.querySelector(".game-finder-dropdown-item__action");
          if (action) action.remove();
        }
        return;
      }
      // Default: close the dropdown — the caller now owns the next step.
      this._close();
    }
  }

  window.GameFinder = GameFinder;
})();
