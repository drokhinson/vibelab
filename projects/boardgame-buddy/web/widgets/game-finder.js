// widgets/game-finder.js — Reusable game-picker combo (input + dropdown).
//
// Searches the BgB library via Game.search(), offers a BoardGameGeek
// fallback when no library hits, and imports a BGG result on tap via
// Game.importBgg(). Picking a result fires the caller-supplied onPick
// callback — the widget itself never mutates collection/session state.
//
// The network is never what the user waits on to see a list. Every keystroke
// paints synchronously first — from an exact cached answer, a cached answer to
// a shorter query this one extends, or the device's own warmed library — and
// /search then refines that in place. Which is why the Gather picker feels
// instant: the game a host is reaching for is nearly always one of their own,
// and every one of those is already on the phone.
//
// Expansions never appear here: /search excludes them from every source
// (library, DB, BGG). They're added through a base game's expansion
// section — see widgets/import-expansions-modal.js.
// Used by:
//   - play-flow-view.js, via widgets/game-picker-sheet.js (Gather: pick the
//     game for a session — mounted inlineDropdown inside the sheet)
//   - widgets/add-game-modal.js (Add to collection / wishlist from spokes)
//
// Each instance owns a unique input + dropdown DOM id so two finders can
// coexist on the same page if needed.

// @ts-check

(function () {
  let _seq = 0;

  // How long after the last keystroke the network search fires. The dropdown
  // is never empty while it waits — every keystroke repaints synchronously
  // from cached results + the device's own library first (see
  // _paintProvisional) — so this budget only delays the refinement.
  const SEARCH_DEBOUNCE_MS = 180;

  // Below this, /search is not called at all.
  //
  // The catalog ILIKE '%q%' is served by a pg_trgm GIN index, and pg_trgm has
  // nothing to match on under three characters — so a 1- or 2-character query
  // is the single most expensive shape the endpoint can be asked for (a seq
  // scan of the whole catalog plus the collection join) in exchange for an
  // alphabetical slice of hundreds of matches that nobody wants. Those two
  // keystrokes are served from the device instead.
  const MIN_REMOTE_QUERY_LEN = 3;

  // Rows painted before the server answers. Matches /search's default limit so
  // the provisional list and the real one are the same length.
  const PROVISIONAL_LIMIT = 20;

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
   * @property {boolean} [inlineDropdown]  Render results as a block in the
   *   flow rather than an absolutely-positioned overlay, and skip the
   *   BgbDropdownFit pass. For a host that already constrains the list —
   *   the Gather game sheet.
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
        <div class="game-finder${this._opts.inlineDropdown ? " game-finder--inline" : ""}" data-search-host>
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
        // peek() rather than get() when offline: get() only serves the 24h
        // fresh window, and a host in a cabin for a weekend would find their
        // own recents gone. peek() serves the full 7d stale window, which is
        // exactly what bootstrap's hostSeed TTL pair was sized for.
        const offline = window.BgbNet && window.BgbNet.isOffline();
        const seeded = offline
          ? window.bgbCache.peek("game.recent", "self")
          : window.bgbCache.get("game.recent", "self");
        if (Array.isArray(seeded)) this._recentGames = seeded;
      }
      // Eagerly start loading recently-played so the dropdown is ready
      // before the user focuses. Failure leaves _recentGames as null so
      // the next focus retries instead of caching an empty list forever.
      this._ensureRecentGamesLoad();
    }

    unmount() {
      clearTimeout(this._searchTimer);
      this._supersede(); // invalidate AND abort any in-flight search
      this._devicePoolRows = null;
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

    // Every keystroke paints SOMETHING synchronously. The network is only ever
    // the refinement pass, never the thing the user waits on before seeing a
    // list: the host picking a game on Gather is almost always picking one of
    // their own, and those are already on the device.
    _onInput(value) {
      clearTimeout(this._searchTimer);
      // The previous keystroke's answer is not wanted any more — drop the
      // response AND the request, so a superseded search stops competing for
      // the connection the current one needs.
      this._supersede();
      this._bggMode = false;
      const q = (value || "").trim();

      // Empty query and offline both resolve with no request at all.
      const offline = !!(window.BgbNet && window.BgbNet.isOffline());
      if (!q || offline) {
        this._renderDropdown(q);
        return;
      }

      // Instant path: a query the user already searched is served from cache
      // with no debounce and no loading flash (backspace / re-type feel live).
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

    // Reveal + size in one call. The dropdown is position:absolute, so a
    // CSS-only max-height overruns the fold whenever the input sits low on
    // screen; BgbDropdownFit measures the space that's actually visible and
    // flips the list above the input when there isn't enough below it.
    //
    // inlineDropdown skips all of that: in a bottom sheet the list is an
    // ordinary block inside a panel already sized to the visible viewport, so
    // there is no fold to measure against and a fit pass would only clamp a
    // list that is already in the right place.
    _show(dd) {
      dd.classList.remove("hidden");
      if (this._opts.inlineDropdown) return;
      if (window.BgbDropdownFit && this._container) {
        window.BgbDropdownFit.fit(dd, this._container.querySelector(".game-finder"));
      }
    }

    _close() {
      const dd = document.getElementById(this.dropdownId);
      if (dd) {
        dd.classList.add("hidden");
        dd.classList.remove("game-finder-dropdown--loading");
        dd.innerHTML = "";
        if (window.BgbDropdownFit) window.BgbDropdownFit.reset(dd);
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
        dd.classList.remove("game-finder-dropdown--loading");
        const list = (this._opts.includeRecentlyPlayed !== false && this._recentGames) || [];
        this._gameById.clear();
        list.forEach((g) => this._gameById.set(g.id, g));
        if (list.length === 0) {
          dd.innerHTML = `<li class="game-finder-dropdown__hint">Type a game name to search.</li>`;
        } else {
          dd.innerHTML =
            `<li class="game-finder-dropdown__header">Recently played</li>` +
            list.map((g) => this._renderRow(g, "recent")).join("");
        }
        this._show(dd);
        this._wireRowClicks(dd);
        window.BgbIcons.render(dd);
        return;
      }

      // Offline: /search is server-side, so filter what's already on the
      // device instead. See _devicePool for what that pool is.
      if (window.BgbNet && window.BgbNet.isOffline()) {
        dd.classList.remove("game-finder-dropdown--loading");
        this._renderOfflineResults(dd, this._deviceMatches(q));
        return;
      }

      // Cache hit → render instantly, no loading state, no network wait.
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
        dd.innerHTML =
          `<li class="game-finder-dropdown__hint">Search failed. Try again.</li>` +
          this._bggFooter(q);
        this._wireRowClicks(dd);
        window.BgbIcons.render(dd);
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
      this._gameById.clear();
      games.forEach((g) => this._gameById.set(g.id, g));

      let rows;
      if (games.length) {
        rows = games.map((g) => this._renderRow(g, "library")).join("");
      } else if (willFetch) {
        rows =
          `<li class="game-finder-dropdown__loading-row">
             <span class="game-finder-spinner" aria-hidden="true"></span>
             <span>Searching…</span>
           </li>`;
      } else {
        // Nothing on the device matches and we deliberately aren't asking the
        // server yet — say which of those it is rather than "no matches".
        rows = `<li class="game-finder-dropdown__hint">Keep typing to search the full library.</li>`;
      }
      dd.innerHTML = rows + this._bggFooter(q);
      // The dimmed/refreshing treatment only reads as "these are being
      // replaced" when there is something to dim.
      dd.classList.toggle("game-finder-dropdown--loading", !!willFetch && games.length > 0);
      this._show(dd);
      this._wireRowClicks(dd);
      window.BgbIcons.render(dd);
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

    // Render library results + the always-visible sticky BGG footer. Shared
    // by the cache-hit and network-response paths.
    _renderResults(dd, data, q) {
      const hits = (data && data.results) || [];
      this._gameById.clear();
      hits.forEach((h) => { if (h && h.game) this._gameById.set(h.game.id, h.game); });

      const rows = hits.length
        ? hits.map((h) => this._renderRow(h.game, "library")).join("")
        : `<li class="game-finder-dropdown__hint">No matches in your library.</li>`;

      dd.innerHTML = rows + this._bggFooter(q);
      this._show(dd);
      this._wireRowClicks(dd);
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
     * which is overwhelmingly what a group is playing — offline in a cabin, and
     * equally at a table with signal, which is why this pool now backs the
     * online first paint too and not just the offline branch. Read through
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
    _renderOfflineResults(dd, games) {
      this._gameById.clear();
      games.forEach((g) => this._gameById.set(g.id, g));
      dd.innerHTML = games.length
        ? `<li class="game-finder-dropdown__header">On this device</li>` +
          games.map((g) => this._renderRow(g, "library")).join("")
        : `<li class="game-finder-dropdown__hint">
             No match on this device. Offline you can only pick games already
             saved here — your collection and recent plays.
           </li>`;
      this._show(dd);
      this._wireRowClicks(dd);
      window.BgbIcons.render(dd);
    }

    // Short, sticky "Search BoardGameGeek" action pinned to the bottom of the
    // dropdown — always offered whenever there's a query, even when the
    // library already has matches, so BGG is one tap away and never buried.
    _bggFooter(q) {
      return `
        <li class="game-finder-dropdown__bgg-footer">
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
        <li class="game-finder-dropdown-item"
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
      // Single delegated listener per render — picks/imports/run-bgg all
      // come through data-finder-action so we never inline onclicks.
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
      dd.innerHTML =
        `<li class="game-finder-dropdown__header">From BoardGameGeek</li>` +
        bgg.map((hit) => `
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
      this._wireRowClicks(dd);
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
