// views/log-play-view.js — Host/Join chooser + "Find a Game that fits"
// browse section.
//
// Two halves on a single screen:
//   • Top: Host / Another Round / Join chooser (with optional Resume
//     banner) under a "Let's play" heading.
//   • Bottom: divider + "Find a Game that fits" — a simplified game browser
//     (My Collection ↔ All BgB Games toggle, players / playtime / game-type
//     filters) rendering a paginated 3×3 grid of Polaroid-style cards.
//     Tapping a card stages the pick in the active PlaySession and jumps
//     into the Gather screen of the host flow.
//
// Routes here from the bottom-nav Play tab, the Profile "+ Add Game" FAB
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
      // Most recent play (own or participated), from the profile bundle.
      // Backs the "Another Round" chooser card; null hides that card.
      this._lastPlay = null;
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

    // Everything the first paint needs, read synchronously from cache. Called
    // by renderLoading() (before onMount runs at all) and again by onMount so
    // a re-entry after a cache warm-up picks up the newer values.
    _hydrateFromCache() {
      this._lastPlay = this._cachedLastPlay();
      this._collectionMap =
        window.store.get("myCollectionMap")
        || (window.Collection.cachedStatusMap && window.Collection.cachedStatusMap())
        || {};
    }

    // View.mount() calls this synchronously before onMount(), so the chooser —
    // Host / Another Round / Join, the resume banner, the filters — is on
    // screen in the tap frame. The grid below renders its loader; nothing here
    // waits on the network. Deliberately does NOT reset _filters / _page /
    // _games: a return visit repaints the user's last filter state instantly.
    renderLoading() {
      this._hydrateFromCache();
      this._loading = true;
      this._error = null;
      this.render();
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
      // renderLoading() already painted the chooser from cache one frame ago
      // (it runs synchronously just before this). Re-hydrating is idempotent
      // and covers the case where that call threw; _loadGames() below paints
      // synchronously either way, so there's no second full render here.
      this._hydrateFromCache();

      // Everything below is unawaited and independent. The status map only
      // feeds badges on the grid far below the fold, so blocking the chooser's
      // paint on it (as this used to) traded the whole screen for a detail.
      window.Collection.myStatusMap()
        .then((m) => {
          if (!this._mounted || !m) return;
          this._collectionMap = m;
          this.render();
        })
        .catch(() => {});
      this._refreshLastPlay();
      const gamesLoaded = this._loadGames();
      // Honor `focus=find` query param from the Profile FAB → scroll the
      // section into view after the first render completes.
      if (this.params && this.params.focus === "find") {
        await gamesLoaded;
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

    // The persisted draft, but only when it's still worth resuming (open
    // lobby, not finalized/abandoned). Drives the resume banner, and gates
    // the overwrite confirm in _anotherRound().
    _resumableSession() {
      const ps = window.PlaySession.load();
      const ok =
        ps &&
        ps.isActive() &&
        ps.code &&
        ps.phase &&
        ps.phase !== "finalized" &&
        ps.phase !== "abandoned";
      return ok ? ps : null;
    }

    render() {
      const ps = this._resumableSession();
      const resumable = !!ps;
      const game = resumable ? ps.gameSnapshot : null;

      this.container.innerHTML = `
        <header class="cascade-chooser__header">
          <h1 class="font-display">Let's play</h1>
        </header>

        ${resumable ? `
          <section class="cascade-chooser__resume">
            <div class="cascade-chooser__resume-body">
              <span class="cascade-chooser__resume-title">Resume hosting?</span>
              <span class="cascade-chooser__resume-meta">
                ${game ? escapeHtml(game.name) : "Game in progress"}
                · code ${escapeHtml(ps.code)}
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

        <div class="cascade-chooser__cards">${this._renderChooserCards()}</div>

        <hr class="lp-divider" />

        <section class="lp-find-section">
          <h2 class="lp-section-title font-display">Find a Game that fits</h2>
          ${this._renderFilters()}
          ${this._renderGrid()}
          ${this._renderPager()}
        </section>
      `;
      this.refreshIcons();
    }

    _renderChooserCards() {
      return `
        <button class="cascade-chooser__card cascade-chooser__card--host"
                onclick="window.logPlayView._host()">
          <span class="cascade-chooser__card-icon">
            <i data-lucide="dice-6" class="w-7 h-7"></i>
          </span>
          <span class="cascade-chooser__card-title">Host a game</span>
          <span class="cascade-chooser__card-body">Open a session, log a play.</span>
        </button>

        ${this._renderAnotherRoundCard()}

        <button class="cascade-chooser__card cascade-chooser__card--join"
                onclick="window.router.go('join-session')">
          <span class="cascade-chooser__card-icon">
            <i data-lucide="qr-code" class="w-7 h-7"></i>
          </span>
          <span class="cascade-chooser__card-title">Join a game</span>
          <span class="cascade-chooser__card-body">Enter a code or join a buddy.</span>
        </button>
      `;
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
        return `<div class="alert alert-error">${escapeHtml(this._error)}</div>`;
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
      // Otherwise start minting one now — see _host() for why the two cases
      // must stay exclusive.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: g.id }).catch(() => {});
      } else {
        window.PlaySession.prefetchLobby({ gameId: g.id });
      }
      window.router.go("play-flow");
    }

    // ── Host ───────────────────────────────────────────────────────────────

    // Kick POST /sessions here rather than letting PlayFlowView.onMount do it,
    // so the round trip overlaps the navigation and first paint instead of
    // following them. By the time Gather renders, the code is usually already
    // in hand.
    //
    // The resumable-session guard is load-bearing, not defensive:
    // bgb_create_session abandons every other open session this host owns, so
    // minting speculatively here would close the lobby the resume banner is
    // offering — before _ensureLobbyOpen ever got to revalidate it.
    _host() {
      if (!this._resumableSession()) {
        const ps = window.store.get("activePlay");
        window.PlaySession.prefetchLobby({ gameId: (ps && ps.gameId) || null });
      }
      window.router.go("play-flow");
    }

    // ── Another Round ──────────────────────────────────────────────────────

    _recentPlayFrom(bundle) {
      const plays = bundle && bundle.recent_plays;
      return (Array.isArray(plays) && plays[0]) || null;
    }

    // Sync source of truth for the Another Round card. The `play.last` seed is
    // written by bootstrap, by every profile-bundle fetch, and by the host
    // flow the instant a play saves — so it survives the profile bundle being
    // invalidated after a save and being expired after 60s, which is what used
    // to make the card arrive late. The bundle peek is the bridge for a
    // session that started before the seed existed.
    _cachedLastPlay() {
      const seed = (window.Play && window.Play.cachedLastPlay)
        ? window.Play.cachedLastPlay()
        : null;
      return seed || this._recentPlayFrom(window.Profile.cachedBundle());
    }

    // SWR refresh behind the sync peek in onMount. Only re-renders when the
    // top play actually changed, so the usual cache hit costs nothing.
    async _refreshLastPlay() {
      let next = null;
      try {
        next = this._recentPlayFrom(await window.Profile.bundle());
      } catch (_) {
        return;
      }
      const before = this._lastPlay && this._lastPlay.id;
      if ((next && next.id) === before) return;
      this._lastPlay = next;
      // Fire-and-forget, so it can land after the user has navigated away —
      // don't paint into a container this view no longer owns. onMount's
      // sync peek picks the refreshed value up on the next visit.
      if (!this._mounted) return;
      this._patchChooserCards();
    }

    // Repaint just the three chooser cards. render() rebuilds the entire
    // container via innerHTML, so using it here yanked the grid down (and
    // reflashed every polaroid) the moment a late last-play landed. With the
    // seed in place this path is rare; when it does run, nothing outside the
    // chooser row moves.
    _patchChooserCards() {
      const el = this.container.querySelector(".cascade-chooser__cards");
      if (!el) { this.render(); return; }
      el.innerHTML = this._renderChooserCards();
      this.refreshIcons(el);
    }

    // Middle chooser card: replay the last game with the same table. Sits
    // between Host and Join — a repeat of last night's game is the more
    // likely tap than entering someone else's code. Only rendered when
    // there IS a last play, so a brand-new account still sees just Host
    // and Join, adjacent. The 48px slot carries the game's box art rather
    // than a Lucide glyph; renderGamePolaroid() is deliberately not reused
    // here, it's a full grid tile (big photo + caption + status badge), not
    // an avatar-sized mark.
    _renderAnotherRoundCard() {
      const p = this._lastPlay;
      if (!p || !p.game_id) return "";
      const names = (p.players || []).map((x) => x.name).filter(Boolean);
      const art = p.game_thumbnail;
      return `
        <button class="cascade-chooser__card cascade-chooser__card--again"
                onclick="window.logPlayView._anotherRound()">
          <span class="cascade-chooser__card-icon${art ? " cascade-chooser__card-icon--photo" : ""}">
            ${art
              ? `<img src="${escapeHtml(art)}" alt="" loading="lazy" />`
              : `<i data-lucide="dice-6" class="w-7 h-7"></i>`}
          </span>
          <span class="cascade-chooser__card-title">Another Round</span>
          <span class="cascade-chooser__card-body cascade-chooser__card-body--players">
            ${names.length ? escapeHtml(names.join(", ")) : "Same game, fresh scores."}
          </span>
        </button>
      `;
    }

    // Stages the previous game + roster into a fresh draft and drops the
    // user on Gather, exactly like the wrap-up card's "Another round?".
    // Same staging contract as _pickFromGrid(): PlayFlowView.onMount() reads
    // PlaySession.load() from localStorage, so persist() before navigating.
    async _anotherRound() {
      const p = this._lastPlay;
      if (!p) return;

      // A new round replaces the persisted draft, so an in-progress session
      // has to be closed out deliberately — same gate and same remote
      // abandon as _discard().
      const open = this._resumableSession();
      if (open) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Start a new round?",
          body: "Your session in progress will be abandoned and its lobby closed.",
          confirmLabel: "Start new round",
          cancelLabel: "Keep playing",
        });
        if (!ok) return;
        if (open.code) {
          try {
            await window.PlaySession.advancePhase(open.code, "abandoned");
          } catch (_) {}
        }
        open.clear();
      }

      // rulebook_url / is_expansion aren't on a play row. Bootstrap warms the
      // game bundle for owned games, so this is usually a free sync hit; when
      // it misses the guide link just resolves later in the host flow.
      const cached = window.bgbCache && window.bgbCache.get("game.bundle", p.game_id);
      const seed = window.PlaySession.seedFromPlayRow(p, (cached && cached.game) || {});
      if (!seed) return;

      const ps = new window.PlaySession({ ...seed, phase: "gather" });
      ps.persist();
      window.store.set("activePlay", ps);
      // Same reference-guide warm-up the grid picker does.
      window.Chapter.prefetchMyChapters(ps.gameId);
      // Mint the lobby now, overlapping it with the navigation. Deliberately
      // below the confirm + abandon above: a user who chose "Keep playing"
      // must never have a session minted behind their back.
      window.PlaySession.prefetchLobby({ gameId: ps.gameId });
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

  window.LogPlayView = LogPlayView;
})();
