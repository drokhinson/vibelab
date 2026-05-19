// views/game-search-view.js — paginated browse with filters + optional BGG extension.
//
// Default landing: shows /games (newest first) so the user can scroll the whole
// catalog. A filter panel narrows the list (players, playtime, mechanics, play
// mode, owned-only). Free-text search filters the SAME list via /games?search=.
// "Search BoardGameGeek for more" extends to /games/search-bgg when the user
// can't find what they want in the local catalog.

(function () {
  const PER_PAGE = 20;

  // Playtime preset bubbles. Inclusive min/max — the backend filters
  // playing_time with `gte(min) / lte(max)`, so a 60-min game shows up
  // in both the "30–60" and "60–90" buckets. Acceptable for a filter UI.
  const PLAYTIME_BUCKETS = [
    { id: "u30",   label: "< 30 min",   min: null, max: 29 },
    { id: "30-60", label: "30–60 min",  min: 30,   max: 60 },
    { id: "60-90", label: "60–90 min",  min: 60,   max: 90 },
    { id: "90-120",label: "90–120 min", min: 90,   max: 120 },
    { id: "o120",  label: "2+ hours",   min: 120,  max: null },
  ];

  function isActiveBucket(b, f) {
    return f.playtimeMin === b.min && f.playtimeMax === b.max;
  }

  class GameSearchView extends window.View {
    constructor() {
      super("game-search");
      this._q = "";
      this._page = 1;
      this._total = 0;
      this._games = [];
      this._loading = false;
      this._error = null;

      this._filtersOpen = false;
      this._filters = this._emptyFilters();
      this._mechanicsOptions = [];

      this._collectionMap = {};   // {gameId: 'owned' | 'wishlist'}
      // Per-base collapse state for expansion sub-rows. Default: all expanded
      // ("not in set" → expanded). A user tap on the chevron adds the base's
      // game id, hiding its expansion block until tapped again.
      this._collapsedBases = new Set();

      this._bggResults = null;    // null = not searched; [] = searched, no hits
      this._bggLoading = false;
    }

    _emptyFilters() {
      return {
        players: null,
        playtimeMin: null,
        playtimeMax: null,
        mechanics: [],
        playMode: null,    // null | 'competitive' | 'coop' | 'team'
        ownedOnly: false,
      };
    }

    async onMount() {
      this._mode = (this.params && this.params.mode) || "browse";
      // React to status-tag picks anywhere — patch the local map so the
      // tag in this list updates instantly.
      this.listen("myCollectionMap", (m) => {
        this._collectionMap = m || {};
        this.render();
      });
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (gameId) this._collectionMap[gameId] = status;
        this.render();
      });
      try {
        const [mechs, statusMap] = await Promise.all([
          window.api.get("/games/mechanics").catch(() => []),
          window.Collection.myStatusMap().catch(() => ({})),
        ]);
        this._mechanicsOptions = Array.isArray(mechs) ? mechs : [];
        this._collectionMap = statusMap || {};
      } catch (_) {}
      await this._load();
      const input = document.getElementById("search-input");
      if (input) input.focus();
    }

    async onParamsChange() {
      // Route from a non-pick context to a pick context (or vice versa)
      // without recreating the view — refresh the mode + re-query so the
      // exclude_expansions filter flips along with the picker banner.
      const prev = this._mode;
      this._mode = (this.params && this.params.mode) || "browse";
      this._page = 1;
      if (prev !== this._mode) this._load();
      else this.render();
    }

    _buildCollectionMap(collection) {
      const out = {};
      // /collection currently returns a flat list[CollectionItem]; future-proof
      // against either that or a paginated {items} envelope.
      const items = Array.isArray(collection)
        ? collection
        : ((collection && collection.items) || []);
      for (const it of items) {
        if (it.status === "owned" || it.status === "wishlist") {
          out[it.game_id] = it.status;
        }
      }
      return out;
    }

    async _load() {
      this._loading = true;
      this._error = null;
      this._bggResults = null;
      this.render();
      try {
        const params = { page: this._page, per_page: PER_PAGE };
        const q = (this._q || "").trim();
        if (q) params.search = q;
        const f = this._filters;
        if (f.players) params.players = f.players;
        if (f.playtimeMin != null) params.playtime_min = f.playtimeMin;
        if (f.playtimeMax != null) params.playtime_max = f.playtimeMax;
        if (f.playMode) params.play_mode = f.playMode;
        if (f.ownedOnly) params.owned_only = "true";
        // Pick-for-play hides expansions: a play is logged against a base
        // game, with expansions attached separately on the Log Play screen.
        // Surfacing expansions in this list would let the user accidentally
        // pick one as the main game.
        if (this._mode === "pick-for-play") params.exclude_expansions = "true";
        // Mechanics — repeated param: /games?mechanics=X&mechanics=Y
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) qs.set(k, v);
        for (const m of f.mechanics) qs.append("mechanics", m);
        const data = await window.api.get("/games?" + qs.toString());
        this._games = (data && data.games) || [];
        this._total = (data && data.total) || 0;
        await this._hydrateOrphanBases();
      } catch (e) {
        this._error = e.message || "Failed to load";
        this._games = [];
        this._total = 0;
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      const totalPages = Math.max(1, Math.ceil(this._total / PER_PAGE));
      const activeFilterCount = this._activeFilterCount();
      // Reloading state: we have results in hand AND a new fetch is in flight
      // (filter / search / page change). The CSS class dims the list and
      // overlays a spinner so the user sees that their action is processing
      // — otherwise the screen just sits there showing stale results.
      const isReloading = this._loading && this._games.length > 0;
      // Capture the search input's focus + caret so a render mid-typing
      // (debounced _load reaches its loading/finished re-render while the
      // user is still typing) doesn't kick them out of the box.
      const active = document.activeElement;
      const restoreFocus = active && active.id === "search-input";
      const selStart = restoreFocus ? active.selectionStart : null;
      const selEnd   = restoreFocus ? active.selectionEnd   : null;
      this.container.innerHTML = `
        ${this._mode === "pick-for-play" ? `
          <div class="search-pick-banner">
            <i data-lucide="play" class="w-3.5 h-3.5"></i>
            <span>Pick a game for your play</span>
          </div>
        ` : ""}
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('${this._mode === "pick-for-play" ? "log-play" : "feed"}')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <form class="search-form" onsubmit="window.gameSearchView._submit(event)">
            <i data-lucide="search" class="w-4 h-4 search-form__icon"></i>
            <input id="search-input" type="text" placeholder="Search games"
                   value="${escapeAttr(this._q)}" class="search-form__input"
                   autocomplete="off" autocapitalize="off" autocorrect="off"
                   oninput="window.gameSearchView._onInput(this.value)" />
            ${this._q
              ? `<button type="button" class="search-form__clear" onclick="window.gameSearchView._clear()">
                   <i data-lucide="x" class="w-3.5 h-3.5"></i>
                 </button>` : ""}
          </form>
          <button class="btn btn-ghost btn-sm relative" title="Filters"
                  onclick="window.gameSearchView._toggleFilters()">
            <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>
            ${activeFilterCount > 0 ? `<span class="search-filter-badge">${activeFilterCount}</span>` : ""}
          </button>
        </header>

        ${this._filtersOpen ? this._renderFilters() : ""}

        <div class="search-meta">
          <span class="text-xs opacity-60">${this._loading ? "Loading…" : `${this._total.toLocaleString()} games`}</span>
        </div>

        <div class="search-results ${isReloading ? "is-reloading" : ""}">
          ${this._renderResults()}
        </div>

        ${this._renderPager(totalPages)}

        ${this._renderBggSection()}
      `;
      if (window.lucide) window.lucide.createIcons();
      if (restoreFocus) {
        const input = document.getElementById("search-input");
        if (input) {
          input.focus();
          if (selStart != null) {
            try { input.setSelectionRange(selStart, selEnd); } catch (_) {}
          }
        }
      }
    }

    _activeFilterCount() {
      const f = this._filters;
      let n = 0;
      if (f.players) n++;
      if (f.playtimeMin != null || f.playtimeMax != null) n++;
      if (f.mechanics.length > 0) n++;
      if (f.playMode) n++;
      if (f.ownedOnly) n++;
      return n;
    }

    _renderFilters() {
      const f = this._filters;
      // Locally-scoped: render() also computes one but it's its own variable.
      // Without this line we'd ReferenceError out of the footer and the panel
      // would silently fail to appear when the user hits the filter button.
      const activeFilterCount = this._activeFilterCount();
      const playerChip = (n) => `
        <button class="filter-chip ${f.players === n ? "is-active" : ""}"
                onclick="window.gameSearchView._setFilter('players', ${f.players === n ? "null" : n})">
          ${n === 7 ? "7+" : n}
        </button>
      `;
      const modeChip = (mode, label) => `
        <button class="filter-chip ${f.playMode === mode ? "is-active" : ""}"
                onclick="window.gameSearchView._setFilter('playMode', ${f.playMode === mode ? "null" : "'" + mode + "'"})">
          ${label}
        </button>
      `;
      const mechChip = (m) => {
        const active = f.mechanics.includes(m);
        return `
          <button class="filter-chip ${active ? "is-active" : ""}"
                  onclick="window.gameSearchView._toggleMechanic('${jsStr(m)}')">
            ${escapeHtml(m)}
          </button>
        `;
      };

      return `
        <section class="search-filters">
          <div class="search-filter-group">
            <label class="search-filter-label">Players</label>
            <div class="filter-chip-row">
              ${[1, 2, 3, 4, 5, 6, 7].map(playerChip).join("")}
            </div>
          </div>
          <div class="search-filter-group">
            <label class="search-filter-label">Playtime (min)</label>
            <div class="filter-chip-row">
              ${PLAYTIME_BUCKETS.map((b) => `
                <button class="filter-chip ${isActiveBucket(b, f) ? "is-active" : ""}"
                        onclick="window.gameSearchView._setPlaytimeBucket('${b.id}')">
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
          <div class="search-filter-group">
            <label class="search-filter-label">
              <input type="checkbox" ${f.ownedOnly ? "checked" : ""}
                     onchange="window.gameSearchView._setFilter('ownedOnly', this.checked)" />
              Only games I own
            </label>
          </div>
          ${this._mechanicsOptions.length > 0 ? `
            <div class="search-filter-group">
              <label class="search-filter-label">Mechanics
                <span class="opacity-50 text-xs">(AND)</span>
              </label>
              <div class="filter-chip-row filter-chip-row--scroll">
                ${this._mechanicsOptions.map(mechChip).join("")}
              </div>
            </div>
          ` : ""}
          ${activeFilterCount > 0 ? `
            <div class="search-filters__footer">
              <button class="btn btn-ghost btn-xs" onclick="window.gameSearchView._clearFilters()">
                Clear filters
              </button>
            </div>
          ` : ""}
        </section>
      `;
    }

    _renderResults() {
      if (this._error) {
        return `<div class="alert alert-error">${escapeHtml(this._error)}</div>`;
      }
      if (this._loading && this._games.length === 0) {
        return window.buddyLoader({ size: 96 });
      }
      if (this._games.length === 0) {
        const isFiltered = this._q || this._activeFilterCount() > 0;
        return `
          <div class="search-empty">
            <p>${isFiltered ? "No matching games in the catalog." : "Catalog is empty."}</p>
            ${this._q
              ? `<button class="btn btn-primary" ${this._bggLoading ? "disabled" : ""} onclick="window.gameSearchView._runBgg()">
                   ${this._bggLoading ? "Searching BGG…" : "Search BoardGameGeek"}
                 </button>` : ""}
          </div>
        `;
      }
      // Group expansions under their base game (when the base is also in
      // the current result set). Expansions whose base isn't visible — e.g.
      // pagination split — fall through as top-level orphan rows so the user
      // doesn't lose them.
      const baseByBgg = new Map();
      for (const g of this._games) {
        if (!g.is_expansion && g.bgg_id != null) baseByBgg.set(g.bgg_id, g);
      }
      const childrenByBaseId = new Map();
      for (const g of this._games) {
        if (!g.is_expansion) continue;
        const parent = g.base_game_bgg_id != null ? baseByBgg.get(g.base_game_bgg_id) : null;
        if (!parent) continue;
        if (!childrenByBaseId.has(parent.id)) childrenByBaseId.set(parent.id, []);
        childrenByBaseId.get(parent.id).push(g);
      }

      const lines = [];
      for (const g of this._games) {
        if (g.is_expansion) {
          const parent = g.base_game_bgg_id != null ? baseByBgg.get(g.base_game_bgg_id) : null;
          if (parent) continue; // already rendered (or about to be) under its parent
          lines.push(this._renderHit(g));                       // orphan expansion
          continue;
        }
        const children = childrenByBaseId.get(g.id) || [];
        const collapsed = this._collapsedBases.has(g.id);
        lines.push(this._renderHit(g, { childrenCount: children.length, collapsed }));
        if (!collapsed && children.length > 0) {
          for (const child of children) {
            lines.push(this._renderHit(child, { isChild: true }));
          }
        }
      }
      return `<ul class="search-list">${lines.join("")}</ul>`;
    }

    _renderHit(g, opts = {}) {
      const status = this._collectionMap[g.id] || null;
      const meta = [
        g.year_published,
        g.min_players && `${g.min_players}${g.max_players && g.max_players !== g.min_players ? "–" + g.max_players : ""}P`,
        g.playing_time && `${g.playing_time}m`,
      ].filter(Boolean).join(" · ");
      const clickHandler = this._mode === "pick-for-play"
        ? `window.gameSearchView._pickForPlay('${g.id}')`
        : `window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || '')}'})`;
      // Leading slot:
      //   - Parent w/ children: a small vertical stack — expansion count on
      //     top, chevron toggle below. Tapping the whole thing flips the
      //     collapse state, so the count doubles as a hit target.
      //   - Child row: a coloured dot bullet (the expansion's own colour
      //     when set, otherwise the accent) acts as the visual indent.
      //   - Plain row: spacer so the body column stays aligned across rows.
      let leading = "";
      if (opts.childrenCount > 0) {
        const icon = opts.collapsed ? "chevron-right" : "chevron-down";
        leading = `
          <button class="search-hit__expand-toggle"
                  aria-label="${opts.collapsed ? "Show" : "Hide"} expansions"
                  title="${opts.collapsed ? "Show" : "Hide"} ${opts.childrenCount} expansion${opts.childrenCount === 1 ? "" : "s"}"
                  onclick="event.stopPropagation();window.gameSearchView._toggleExpansions('${g.id}')">
            <span class="search-hit__expand-count">${opts.childrenCount}</span>
            <i data-lucide="${icon}" class="w-4 h-4"></i>
          </button>
        `;
      } else if (opts.isChild) {
        leading = `<span class="search-hit__exp-dot" aria-hidden="true"></span>`;
      } else {
        leading = `<span class="search-hit__expand-toggle search-hit__expand-toggle--placeholder"></span>`;
      }
      const rowClass = `search-hit ${opts.isChild ? "search-hit--child" : ""}`;
      const expColor = opts.isChild && g.expansion_color ? ` style="--exp-color:${escapeAttr(g.expansion_color)}"` : "";
      return `
        <li class="${rowClass}"${expColor} onclick="${clickHandler}">
          ${leading}
          ${g.thumbnail_url ? `<img src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" />` : `<div class="search-hit__placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="search-hit__body">
            <div class="search-hit__name">${escapeHtml(g.name)}</div>
            <div class="search-hit__meta">${escapeHtml(meta)}</div>
          </div>
          ${window.renderStatusTag(g.id, status, { size: "xs" })}
        </li>
      `;
    }

    _toggleExpansions(baseId) {
      if (this._collapsedBases.has(baseId)) this._collapsedBases.delete(baseId);
      else this._collapsedBases.add(baseId);
      this.render();
    }

    // After the main search returns, scan for expansions whose base game
    // isn't in the result set. Fetch those bases by bgg_id and prepend them
    // so every shown expansion has a visible parent — even if doing so pushes
    // the visible list beyond the per-page slice. The pager's `total` stays
    // anchored to the original search count.
    async _hydrateOrphanBases() {
      const games = this._games || [];
      if (games.length === 0) return;
      const presentBaseBggIds = new Set();
      for (const g of games) {
        if (!g.is_expansion && g.bgg_id != null) presentBaseBggIds.add(g.bgg_id);
      }
      const missing = [];
      const seen = new Set();
      for (const g of games) {
        if (!g.is_expansion) continue;
        const baseBgg = g.base_game_bgg_id;
        if (baseBgg == null || presentBaseBggIds.has(baseBgg) || seen.has(baseBgg)) continue;
        missing.push(baseBgg);
        seen.add(baseBgg);
      }
      if (missing.length === 0) return;
      try {
        const data = await window.api.get(
          "/games?bgg_ids=" + encodeURIComponent(missing.join(","))
        );
        const bases = (data && data.games) || [];
        if (bases.length === 0) return;
        // Prepend so the hydrated bases sit at the top — the grouping pass
        // will thread each orphan expansion right under its base on render.
        this._games = [...bases, ...games];
      } catch (_) {
        /* Hydration is best-effort; on failure leave expansions as orphans. */
      }
    }

    _pickForPlay(gameId) {
      const g = (this._games || []).find((x) => x.id === gameId);
      if (!g) return;
      const ps = window.store.get("activePlay") || new window.PlaySession();
      ps.gameId = g.id;
      ps.gameSnapshot = {
        id: g.id,
        name: g.name,
        thumbnail_url: g.thumbnail_url,
        rulebook_url: g.rulebook_url,
      };
      ps.playMode = g.play_mode || ps.playMode || null;
      ps.persist();
      window.store.set("activePlay", ps);
      // Fire-and-forget: if this host is sharing a lobby code, push the game
      // pick so joiners see it on their next poll.
      if (ps.code) {
        window.PlaySession.updateLobby(ps.code, { gameId: g.id }).catch(() => {});
      }
      window.router.back("log-play");
    }

    _renderPager(totalPages) {
      if (totalPages <= 1) return "";
      return `
        <nav class="search-pager">
          <button class="btn btn-ghost btn-sm" ${this._page <= 1 ? "disabled" : ""}
                  onclick="window.gameSearchView._goPage(${this._page - 1})">
            <i data-lucide="chevron-left" class="w-4 h-4"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._page} of ${totalPages}</span>
          <button class="btn btn-ghost btn-sm" ${this._page >= totalPages ? "disabled" : ""}
                  onclick="window.gameSearchView._goPage(${this._page + 1})">
            Next <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </nav>
      `;
    }

    _renderBggSection() {
      // Only surface the BGG extension when the user has typed a query.
      if (!this._q) return "";
      if (this._bggResults === null) {
        return `
          <div class="search-extend">
            <button class="btn btn-ghost btn-sm" ${this._bggLoading ? "disabled" : ""}
                    onclick="window.gameSearchView._runBgg()">
              ${this._bggLoading ? "Searching BGG…" : "Search BoardGameGeek for more"}
            </button>
          </div>
        `;
      }
      if (this._bggResults.length === 0) {
        return `<div class="text-sm opacity-60 p-3">No additional BGG matches.</div>`;
      }
      return `
        <section class="search-bgg-section">
          <h4 class="search-bgg-heading">From BoardGameGeek</h4>
          <ul class="search-list">
            ${this._bggResults.map((hit) => this._renderBggHit(hit)).join("")}
          </ul>
        </section>
      `;
    }

    _renderBggHit(hit) {
      const meta = [hit.year_published, hit.is_expansion ? "Expansion" : null].filter(Boolean).join(" · ");
      return `
        <li class="search-hit search-hit--bgg" onclick="window.gameSearchView._importBgg(${hit.bgg_id})">
          <div class="search-hit__placeholder"><i data-lucide="dice-6"></i></div>
          <div class="search-hit__body">
            <div class="search-hit__name">${escapeHtml(hit.name)}</div>
            <div class="search-hit__meta">${escapeHtml(meta)}${hit.already_in_db ? " · In library" : ""}</div>
          </div>
          <button class="btn btn-ghost btn-xs">${hit.already_in_db ? "Open" : "Import"}</button>
        </li>
      `;
    }

    // ── Actions ────────────────────────────────────────────────────────────

    _toggleFilters() {
      this._filtersOpen = !this._filtersOpen;
      this.render();
    }

    _setFilter(key, value, reload = true) {
      this._filters[key] = value;
      this._page = 1;
      if (reload) this._load();
      else this.render();
    }

    _toggleMechanic(name) {
      const list = this._filters.mechanics;
      const i = list.indexOf(name);
      if (i >= 0) list.splice(i, 1);
      else list.push(name);
      this._page = 1;
      this._load();
    }

    _clearFilters() {
      this._filters = this._emptyFilters();
      this._page = 1;
      this._load();
    }

    _setPlaytimeBucket(id) {
      const f = this._filters;
      const cur = PLAYTIME_BUCKETS.find((b) => isActiveBucket(b, f));
      const next = (cur && cur.id === id) ? null : PLAYTIME_BUCKETS.find((b) => b.id === id);
      f.playtimeMin = next ? next.min : null;
      f.playtimeMax = next ? next.max : null;
      this._page = 1;
      this._load();
    }

    _clear() {
      clearTimeout(this._searchTimer);
      this._q = "";
      this._page = 1;
      this._load();
      const input = document.getElementById("search-input");
      if (input) input.focus();
    }

    _onInput(value) {
      this._q = value || "";
      this._page = 1;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._load(), 220);
    }

    _submit(event) {
      event.preventDefault();
      clearTimeout(this._searchTimer);
      const input = document.getElementById("search-input");
      this._q = (input.value || "").trim();
      this._page = 1;
      this._load();
    }

    _goPage(n) {
      this._page = n;
      this._load();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    async _runBgg() {
      if (!this._q) return;
      this._bggLoading = true;
      this.render();
      try {
        const data = await window.api.get("/games/search-bgg", { query: this._q });
        this._bggResults = Array.isArray(data) ? data : [];
      } catch (e) {
        this._bggResults = [];
      } finally {
        this._bggLoading = false;
        this.render();
      }
    }

    async _importBgg(bggId) {
      try {
        const data = await window.api.post(`/games/import-bgg`, { bgg_id: bggId });
        if (data && data.id) {
          window.router.go("game-detail", { gameId: data.id, gameName: data.name || "" });
        }
      } catch (e) {
        alert(e.message || "Import failed");
      }
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  // Escape for a JS string literal that lives inside an HTML "…" attribute.
  // Browsers decode HTML entities before the JS parser sees the value, so we
  // can't rely on &#39; — we need backslash escapes that survive that step.
  function jsStr(s) {
    return String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n");
  }

  window.GameSearchView = GameSearchView;
})();
