// views/log-play-view.js — Host/Join chooser + "Find a Game that fits"
// browse section.
//
// Two halves on a single screen:
//   • Top: Host or Join chooser (with optional Resume banner) and a short
//     prompt at the top: "Know your Game? Join or host a session."
//   • Bottom: divider + "Find a Game that fits" — a simplified game browser
//     (My Collection ↔ All BgB Games toggle, players / playtime / game-type
//     filters) rendering a paginated 3×3 grid of Polaroid-style cards.
//     Tapping a card stages the pick in the active PlaySession and jumps
//     into the Gather screen of the host flow.
//
// Routes here from the bottom-nav Play disc, the Profile "+ Add Game" FAB
// (passes `focus=find` to scroll to the section), and the Gather screen's
// inline picker when the user opts to browse instead.

(function () {
  const PER_PAGE = 9;

  // Playtime preset bubbles. Inclusive min/max — matches the backend filter
  // (`gte(min) / lte(max)`), so a 60-min game shows up in both the "30–60"
  // and "60–90" buckets. Acceptable for a filter UI.
  const PLAYTIME_BUCKETS = [
    { id: "u30",    label: "< 30m",     min: null, max: 29 },
    { id: "30-60",  label: "30–60m",    min: 30,   max: 60 },
    { id: "60-90",  label: "60–90m",    min: 60,   max: 90 },
    { id: "90-120", label: "90–120m",   min: 90,   max: 120 },
    { id: "o120",   label: "2+ hours",  min: 120,  max: null },
  ];

  function isActiveBucket(b, f) {
    return f.playtimeMin === b.min && f.playtimeMax === b.max;
  }

  class LogPlayView extends window.View {
    constructor() {
      super("log-play");
      this._filters = this._emptyFilters();
      this._page = 1;
      this._games = [];
      this._total = 0;
      this._loading = false;
      this._error = null;
      this._scopeAutoSwitched = false;
      // Per-game owned/wishlist/played status map. Populated from
      // Collection.myStatusMap() on mount; patched live by status-changed
      // CustomEvents fired from the status-picker.
      this._collectionMap = {};
      // Infinite-scroll plumbing. _loadToken invalidates stale page-2+
      // fetches whose filter context changed mid-flight; _observer watches
      // the sentinel at the bottom of the grid and triggers the next page.
      this._loadToken = 0;
      this._observer = null;
    }

    _emptyFilters() {
      return {
        scope: "mine",        // 'mine' | 'all'
        players: null,
        playtimeMin: null,
        playtimeMax: null,
        playMode: null,        // null | 'competitive' | 'coop' | 'team'
      };
    }

    async onMount() {
      // Keep the polaroid status badges in sync with any other view that
      // mutates the user's collection (game-detail status picker, profile
      // grid, etc.). The status-tag picker dispatches `status-changed` on
      // document; the shared collection cache also pushes into the store.
      this.listen("myCollectionMap", (m) => {
        this._collectionMap = m || {};
        this.render();
      });
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = (e && e.detail) || {};
        if (!gameId) return;
        if (status == null) delete this._collectionMap[gameId];
        else this._collectionMap[gameId] = status;
        this.render();
      });
      try {
        this._collectionMap = (await window.Collection.myStatusMap()) || {};
      } catch (_) {
        this._collectionMap = {};
      }
      this.render();
      this._installScrollObserver();
      await this._loadGames({ reset: true });
      // Honor `focus=find` query param from the Profile FAB → scroll the
      // section into view after the first render completes.
      if (this.params && this.params.focus === "find") {
        requestAnimationFrame(() => {
          const el = this.container.querySelector(".lp-find-section");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }

    async onUnmount() {
      this._uninstallScrollObserver();
    }

    // IntersectionObserver — bottom-of-grid sentinel triggers the next page.
    // 240px rootMargin gives the user roughly half a viewport of runway
    // before the next batch lands, so they rarely see an empty space at the
    // bottom while scrolling. Observer is reattached after every render
    // because the sentinel DOM node is recreated on each repaint.
    _installScrollObserver() {
      if (this._observer) return;
      this._observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this._loadMore();
        }
      }, { rootMargin: "240px 0px" });
      this._observeSentinel();
    }

    _observeSentinel() {
      if (!this._observer) return;
      const el = this.container.querySelector("#lp-find-sentinel");
      if (el) this._observer.observe(el);
    }

    _uninstallScrollObserver() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
    }

    _loadMore() {
      if (this._loading) return;
      if (this._games.length >= this._total) return;
      this._page += 1;
      this._loadGames({ reset: false });
    }

    // _loadGames({reset}). reset=true wipes _games and fetches page 1 (used
    // for filter changes, scope toggles, first mount). reset=false appends
    // the current _page to the existing list (used by the infinite-scroll
    // sentinel). A bumped _loadToken cancels any stale append whose filter
    // context changed mid-flight.
    async _loadGames({ reset = false } = {}) {
      if (reset) {
        this._page = 1;
        this._games = [];
        this._total = 0;
      }
      const token = ++this._loadToken;
      this._loading = true;
      this._error = null;
      this.render();
      try {
        const qs = new URLSearchParams();
        qs.set("page", String(this._page));
        qs.set("per_page", String(PER_PAGE));
        qs.set("exclude_expansions", "true");
        if (this._filters.players) qs.set("players", String(this._filters.players));
        if (this._filters.playtimeMin != null) qs.set("playtime_min", String(this._filters.playtimeMin));
        if (this._filters.playtimeMax != null) qs.set("playtime_max", String(this._filters.playtimeMax));
        if (this._filters.playMode) qs.set("play_mode", this._filters.playMode);

        let newGames = [];
        let newTotal = 0;
        if (this._filters.scope === "mine") {
          qs.set("status", "owned");
          qs.set("sort", "added_at");
          const data = await window.api.get("/collection/grid?" + qs.toString());
          newGames = data && data.items ? data.items.map((it) => it.game) : [];
          newTotal = (data && data.total) || 0;
        } else {
          const data = await window.api.get("/games?" + qs.toString());
          newGames = (data && data.games) || [];
          newTotal = (data && data.total) || 0;
        }

        if (token !== this._loadToken) return; // stale fetch — filters moved

        this._games = reset ? newGames : [...this._games, ...newGames];
        this._total = newTotal;

        // Auto-switch scope to "All BgB Games" when the user has nothing
        // owned matching their unfiltered query — only fires on the first
        // page of a reset load so the user can opt back to "My Collection"
        // without ping-ponging.
        if (reset
            && this._filters.scope === "mine"
            && this._total === 0
            && !this._scopeAutoSwitched
            && this._activeFilterCount() === 0) {
          this._scopeAutoSwitched = true;
          this._filters.scope = "all";
          await this._loadGames({ reset: true });
          return;
        }
      } catch (e) {
        if (token !== this._loadToken) return;
        this._error = e.message || "Failed to load games";
        if (reset) {
          this._games = [];
          this._total = 0;
        } else {
          // Failed append: roll _page back so the user can scroll past the
          // sentinel again to retry instead of being stuck.
          this._page = Math.max(1, this._page - 1);
        }
      } finally {
        if (token === this._loadToken) {
          this._loading = false;
          this.render();
          this._observeSentinel();
        }
      }
    }

    _activeFilterCount() {
      const f = this._filters;
      let n = 0;
      if (f.players) n++;
      if (f.playtimeMin != null || f.playtimeMax != null) n++;
      if (f.playMode) n++;
      return n;
    }

    render() {
      const ps = window.PlaySession.load();
      const resumable =
        ps &&
        ps.isActive() &&
        ps.code &&
        ps.phase &&
        ps.phase !== "finalized" &&
        ps.phase !== "abandoned";
      const game = resumable ? ps.gameSnapshot : null;

      this.container.innerHTML = `
        <header class="cascade-chooser__header">
          <h1 class="font-display">Know your Game?</h1>
          <p class="cascade-chooser__lead">Join or host a session.</p>
        </header>

        ${resumable ? `
          <section class="cascade-chooser__resume">
            <div class="cascade-chooser__resume-body">
              <span class="cascade-chooser__resume-title">Resume hosting?</span>
              <span class="cascade-chooser__resume-meta">
                ${game ? escape(game.name) : "Game in progress"}
                · code ${escape(ps.code)}
              </span>
            </div>
            <div class="cascade-chooser__resume-actions">
              <button class="btn btn-primary btn-sm"
                      onclick="window.logPlayView._resume()">
                Resume
              </button>
              <button class="btn btn-ghost btn-sm"
                      onclick="window.logPlayView._discard()">
                Discard
              </button>
            </div>
          </section>
        ` : ""}

        <div class="cascade-chooser__cards">
          <button class="cascade-chooser__card cascade-chooser__card--host"
                  onclick="window.router.go('play-flow')">
            <span class="cascade-chooser__card-icon">
              <i data-lucide="dice-6" class="w-7 h-7"></i>
            </span>
            <span class="cascade-chooser__card-title">Host a game</span>
            <span class="cascade-chooser__card-body">Open a session, log a play.</span>
          </button>

          <button class="cascade-chooser__card cascade-chooser__card--join"
                  onclick="window.router.go('join-session')">
            <span class="cascade-chooser__card-icon">
              <i data-lucide="qr-code" class="w-7 h-7"></i>
            </span>
            <span class="cascade-chooser__card-title">Join a game</span>
            <span class="cascade-chooser__card-body">Enter a code or join a buddy.</span>
          </button>
        </div>

        <hr class="lp-divider" />

        <section class="lp-find-section">
          <h2 class="lp-section-title font-display">Find a Game that fits</h2>
          ${this._renderFilters()}
          ${this._renderGrid()}
          ${this._renderSentinel()}
        </section>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    _renderFilters() {
      const f = this._filters;
      const playerChip = (n) => `
        <button class="lp-chip ${f.players === n ? "is-active" : ""}"
                onclick="window.logPlayView._setFilter('players', ${f.players === n ? "null" : n})">
          ${n === 7 ? "7+" : n}
        </button>`;
      const modeChip = (mode, label) => `
        <button class="lp-chip ${f.playMode === mode ? "is-active" : ""}"
                onclick="window.logPlayView._setFilter('playMode', ${f.playMode === mode ? "null" : "'" + mode + "'"})">
          ${label}
        </button>`;
      return `
        <div class="lp-filters">
          <div class="lp-scope-toggle" role="tablist" aria-label="Game source">
            <button class="lp-scope-toggle__opt ${f.scope === "mine" ? "is-active" : ""}"
                    role="tab" aria-selected="${f.scope === "mine"}"
                    onclick="window.logPlayView._setScope('mine')">
              My Collection
            </button>
            <button class="lp-scope-toggle__opt ${f.scope === "all" ? "is-active" : ""}"
                    role="tab" aria-selected="${f.scope === "all"}"
                    onclick="window.logPlayView._setScope('all')">
              All BgB Games
            </button>
          </div>
          <div class="lp-filter-row">
            <span class="lp-filter-label">Players</span>
            <div class="lp-chip-row">
              ${[1, 2, 3, 4, 5, 6, 7].map(playerChip).join("")}
            </div>
          </div>
          <div class="lp-filter-row">
            <span class="lp-filter-label">Play time</span>
            <div class="lp-chip-row">
              ${PLAYTIME_BUCKETS.map((b) => `
                <button class="lp-chip ${isActiveBucket(b, f) ? "is-active" : ""}"
                        onclick="window.logPlayView._setPlaytimeBucket('${b.id}')">
                  ${b.label}
                </button>`).join("")}
            </div>
          </div>
          <div class="lp-filter-row">
            <span class="lp-filter-label">Type</span>
            <div class="lp-chip-row">
              ${modeChip("competitive", "Competitive")}
              ${modeChip("coop", "Co-op")}
              ${modeChip("team", "Team")}
            </div>
          </div>
        </div>
      `;
    }

    _renderGrid() {
      if (this._error) {
        return `<div class="alert alert-error">${escape(this._error)}</div>`;
      }
      if (this._loading && this._games.length === 0) {
        return `<div class="lp-find-loading">${window.buddyLoader({ size: 72 })}</div>`;
      }
      if (this._games.length === 0) {
        const inCollection = this._filters.scope === "mine";
        return `
          <div class="lp-find-empty">
            <p>${inCollection
              ? "No games in your collection match these filters."
              : "No games match these filters."}</p>
            ${this._activeFilterCount() > 0
              ? `<button class="btn btn-ghost btn-sm" onclick="window.logPlayView._clearFilters()">
                   Clear filters
                 </button>`
              : ""}
          </div>
        `;
      }
      const cards = this._games.map((g) => window.renderGamePolaroid(g, {
        clickHandler: `window.logPlayView._pickFromGrid('${jsStr(g.id)}')`,
        collectionStatus: this._collectionMap[g.id] || null,
      })).join("");
      return `<div class="lp-find-grid">${cards}</div>`;
    }

    // Bottom-of-grid sentinel for the IntersectionObserver. Three states:
    //   • more to load + actively loading → spinner
    //   • more to load + idle            → empty 1px node the observer
    //                                       watches (next-page trigger)
    //   • all loaded                     → "That's all" footer (or nothing
    //                                       if only one page existed)
    _renderSentinel() {
      const hasMore = this._games.length < this._total;
      if (hasMore) {
        if (this._loading) {
          return `<div class="lp-find-sentinel lp-find-sentinel--loading" id="lp-find-sentinel">
            ${window.buddyLoader({ size: 48, padded: false })}
          </div>`;
        }
        return `<div class="lp-find-sentinel" id="lp-find-sentinel" aria-hidden="true"></div>`;
      }
      if (this._games.length > PER_PAGE) {
        return `<div class="lp-find-sentinel lp-find-sentinel--done">That's all.</div>`;
      }
      return "";
    }

    // ── Actions ────────────────────────────────────────────────────────────

    _setScope(scope) {
      if (this._filters.scope === scope) return;
      this._filters.scope = scope;
      // Manual scope switch overrides the empty-collection auto-fallback.
      this._scopeAutoSwitched = true;
      this._loadGames({ reset: true });
    }

    _setFilter(key, value) {
      this._filters[key] = value;
      this._loadGames({ reset: true });
    }

    _setPlaytimeBucket(id) {
      const f = this._filters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = cur && cur.id === id ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._loadGames({ reset: true });
    }

    _clearFilters() {
      const scope = this._filters.scope;
      this._filters = this._emptyFilters();
      this._filters.scope = scope;
      this._loadGames({ reset: true });
    }

    _pickFromGrid(gameId) {
      const g = this._games.find((x) => x.id === gameId);
      if (!g) return;
      const ps = window.store.get("activePlay") || new window.PlaySession();
      ps.gameId = g.id;
      ps.gameSnapshot = {
        id: g.id,
        name: g.name,
        thumbnail_url: g.thumbnail_url,
        rulebook_url: g.rulebook_url,
        is_expansion: !!g.is_expansion,
      };
      ps.playMode = g.play_mode || ps.playMode || null;
      ps.persist();
      window.store.set("activePlay", ps);
      // If a lobby is already open (e.g. user came back after starting a
      // host session), push the swap to the server so joiners see it.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: g.id }).catch(() => {});
      }
      window.router.go("play-flow");
    }

    // ── Resume banner ──────────────────────────────────────────────────────

    _resume() {
      window.router.go("play-flow");
    }

    async _discard() {
      const ok = await window.PolaroidPopup.confirm({
        title: "Discard this play?",
        body: "The lobby will close and the in-progress draft will be cleared.",
        confirmLabel: "Discard",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
      const ps = window.PlaySession.load();
      if (ps && ps.code) {
        try {
          await window.PlaySession.advancePhase(ps.code, "abandoned");
        } catch (_) {}
      }
      if (ps) ps.clear();
      window.store.set("activePlay", null);
      this.render();
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  // Escape for a JS string literal that lives inside an HTML "…" attribute.
  // Browsers decode HTML entities before the JS parser sees the value, so we
  // can't rely on &#39; — we need backslash escapes that survive that step.
  function jsStr(s) {
    return String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n");
  }

  window.LogPlayView = LogPlayView;
})();
