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
      await this._loadGames();
      // Honor `focus=find` query param from the Profile FAB → scroll the
      // section into view after the first render completes.
      if (this.params && this.params.focus === "find") {
        requestAnimationFrame(() => {
          const el = this.container.querySelector(".lp-find-section");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }

    async _loadGames() {
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

        if (this._filters.scope === "mine") {
          qs.set("status", "owned");
          qs.set("sort", "added_at");
          const data = await window.api.get("/collection/grid?" + qs.toString());
          this._games = (data && data.items ? data.items.map((it) => it.game) : []);
          this._total = (data && data.total) || 0;
          // Auto-switch to "All BgB Games" when the user has nothing owned
          // matching their filters — only on first load (avoid an infinite
          // toggle loop if the catalog scope also returns nothing).
          if (this._total === 0 && !this._scopeAutoSwitched && this._activeFilterCount() === 0) {
            this._scopeAutoSwitched = true;
            this._filters.scope = "all";
            await this._loadGames();
            return;
          }
        } else {
          const data = await window.api.get("/games?" + qs.toString());
          this._games = (data && data.games) || [];
          this._total = (data && data.total) || 0;
        }
      } catch (e) {
        this._error = e.message || "Failed to load games";
        this._games = [];
        this._total = 0;
      } finally {
        this._loading = false;
        this.render();
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
          ${this._renderPager()}
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
      return `<div class="lp-find-grid ${this._loading ? "is-reloading" : ""}">${cards}</div>`;
    }

    _renderPager() {
      const totalPages = Math.max(1, Math.ceil(this._total / PER_PAGE));
      if (totalPages <= 1) return "";
      return `
        <nav class="lp-find-pager">
          <button class="btn btn-ghost btn-sm" ${this._page <= 1 ? "disabled" : ""}
                  onclick="window.logPlayView._goPage(${this._page - 1})">
            <i data-lucide="chevron-left" class="w-4 h-4"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._page} of ${totalPages}</span>
          <button class="btn btn-ghost btn-sm" ${this._page >= totalPages ? "disabled" : ""}
                  onclick="window.logPlayView._goPage(${this._page + 1})">
            Next <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    // ── Actions ────────────────────────────────────────────────────────────

    _setScope(scope) {
      if (this._filters.scope === scope) return;
      this._filters.scope = scope;
      this._page = 1;
      // Manual scope switch overrides the empty-collection auto-fallback.
      this._scopeAutoSwitched = true;
      this._loadGames();
    }

    _setFilter(key, value) {
      this._filters[key] = value;
      this._page = 1;
      this._loadGames();
    }

    _setPlaytimeBucket(id) {
      const f = this._filters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = cur && cur.id === id ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._page = 1;
      this._loadGames();
    }

    _clearFilters() {
      const scope = this._filters.scope;
      this._filters = this._emptyFilters();
      this._filters.scope = scope;
      this._page = 1;
      this._loadGames();
    }

    _goPage(n) {
      this._page = n;
      this._loadGames();
      const el = this.container.querySelector(".lp-find-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
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
      // Warm the reference-guide cache in the background so the guide is
      // instant once the host lands on the Play screen (or opens game detail).
      window.Chapter.prefetchMyChapters(g.id);
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
