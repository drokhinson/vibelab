// views/game-detail-view.js — game detail w/ collection toggle + rulebook link
// + expansions list (base game → expansions, expansion → base game).

(function () {
  class GameDetailView extends window.View {
    constructor() {
      super("game-detail");
      this._game = null;
      this._status = null;
      this._plays = [];
      this._expansions = [];  // ExpansionListItem[] (only for base games)
      this._loading = false;
      this._error = null;
      this._expansionsOpen = false;
      this._guide = null;  // ReferenceGuideScroll widget; instantiated on first render
    }

    async onMount() {
      this._statusMap = {};
      this.listen("myCollectionMap", (m) => {
        this._statusMap = m || {};
        this.render();
      });
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (gameId) this._statusMap[gameId] = status;
        // If the game on this page just changed, also refresh the action
        // button at the top so it tracks the new status.
        if (this._game && gameId === this._game.id) this._status = status;
        this.render();
      });
      this.listenDom("chapters-changed", (e) => {
        // The widget may not exist yet during the initial _load, and a
        // chapter add could be for the base game OR for an active
        // expansion — refresh whenever the widget has a game in scope.
        if (this._guide) this._guide.refresh();
      });
      window.Collection.myStatusMap()
        .then((m) => { this._statusMap = m || {}; this.render(); })
        .catch(() => {});
      await this._load();
    }
    async onParamsChange() { await this._load(); }

    async _load() {
      const id = this.params && this.params.gameId;
      if (!id) {
        this._error = "No game specified";
        this.render();
        return;
      }
      // Clear the previous game first so we never flash stale data when
      // navigating between two game-detail pages (expansion → base game,
      // search hit while another game is open, etc.). Callers can pass a
      // `gameName` param so the loader caption reads "Looking up <name>";
      // otherwise it falls back to a generic line.
      this._game = null;
      this._status = null;
      this._plays = [];
      this._expansions = [];
      this._expansionsOpen = false;
      this._guide = null;
      this._error = null;
      this._loading = true;
      this.render();
      try {
        // Single round trip via /games/{id}/bundle (Phase 3) — replaces the
        // serial Game.fetch + parallel status/plays/expansions fan-out.
        const bundle = await window.Game.detailBundle(id, { playsLimit: 5 });
        if (!bundle || !bundle.game) {
          throw new Error("Game not found");
        }
        this._game = new window.Game(bundle.game);
        // base_game_id / base_game_name are nested under .base_game in the
        // bundle but the existing render code reads them off `this._game`.
        // Patch the props on so the back-to-base link keeps working.
        if (bundle.base_game) {
          this._game.base_game_id = bundle.base_game.id;
          this._game.base_game_name = bundle.base_game.name;
        }
        this._status = bundle.viewer_status || null;
        this._plays = bundle.recent_plays || [];
        this._expansions = Array.isArray(bundle.expansions) ? bundle.expansions : [];
        // Defence in depth: pre-migration-023 the bundle's viewer_status was
        // null for games the viewer had only played (no collection row).
        // Derive 'played' from the recent_plays block so the hero banner
        // paints the purple Played pill even before that migration runs.
        if (!this._status && this._plays.length > 0) {
          this._status = "played";
        }
      } catch (e) {
        this._error = e.message || "Failed to load game";
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      if (this._error) {
        this.container.innerHTML = `
          <header class="search-topbar">
            <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')"><i data-lucide="arrow-left" class="w-4 h-4"></i></button>
          </header>
          <div class="p-6 alert alert-error">${escape(this._error)}</div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!this._game) {
        const name = (this.params && this.params.gameName) || null;
        const label = name ? `Looking up ${name} info` : "Looking up game info";
        this.container.innerHTML = window.buddyLoader({ size: 120, label });
        return;
      }
      const g = this._game;
      const accent = g.accentColor();
      const status = this._status;

      this.container.innerHTML = `
        <article class="game-detail" style="--game-accent:${accent}">
          <header class="game-detail__hero" id="game-detail-hero">
            <button class="btn btn-ghost btn-sm game-detail__back" onclick="window.router.back('feed')">
              <i data-lucide="arrow-left" class="w-4 h-4"></i>
            </button>
            ${g.image_url || g.thumbnail_url ? `<img id="game-detail-hero-img" class="game-detail__hero-img" src="${g.image_url || g.thumbnail_url}" alt="" />` : ""}
            <span class="game-detail__hero-status">
              ${window.renderStatusTag(g.id, status, { size: "lg", addLabel: "Add" })}
            </span>
            <div class="game-detail__hero-veil"></div>
          </header>
          <div class="game-detail__body">
            <h1 class="game-detail__name font-display">${escape(g.name)}</h1>
            ${this._renderBaseGameLink(g)}
            <div class="game-detail__meta">
              ${g.is_expansion ? `<span class="game-detail__meta-chip"><i data-lucide="puzzle" class="w-3.5 h-3.5"></i> Expansion</span>` : ""}
              ${g.year_published ? `<span>${g.year_published}</span>` : ""}
              ${g.playerRangeText() ? `<span>${g.playerRangeText()}</span>` : ""}
              ${g.playTimeText() ? `<span>${g.playTimeText()}</span>` : ""}
            </div>
            <div class="game-detail__actions">
              ${g.is_expansion ? "" : `
                <button class="btn btn-secondary game-detail__action" onclick="window.gameDetailView._startPlay()">
                  <i data-lucide="play" class="w-4 h-4"></i> Log a play
                </button>
              `}
              ${g.bggUrl() ? `<a class="btn game-detail__action game-detail__link-btn game-detail__link-btn--bgg"
                                href="${g.bggUrl()}" target="_blank" rel="noopener">
                <i data-lucide="external-link" class="w-4 h-4"></i> BGG
              </a>` : `<button class="btn game-detail__action game-detail__link-btn game-detail__link-btn--disabled" disabled
                                title="No BGG link available">
                <i data-lucide="external-link" class="w-4 h-4"></i> BGG
              </button>`}
              ${this._renderRulebookButton(g)}
            </div>
            ${g.description ? `<div class="game-detail__desc">${stripHtml(g.description)}</div>` : ""}
            ${this._renderExpansions()}
            ${this._renderReferenceGuide()}
            ${this._renderRecentPlays()}
          </div>
        </article>
      `;
      if (window.lucide) window.lucide.createIcons();
      this._mountGuide();
      // Defer the canvas sample until after layout so it doesn't block the
      // synchronous render path. Cache hits short-circuit immediately.
      requestAnimationFrame(() => this._sampleHeroEdgeColor());
    }

    // Sample the leftmost + rightmost columns of the hero image and use the
    // averaged colour as the banner gutter fill. Cached by URL so re-renders
    // (status flips, route re-mounts) reuse the result. Silent fallback to
    // the per-game accent if the image can't be read (CORS, load error).
    _sampleHeroEdgeColor() {
      const hero = document.getElementById("game-detail-hero");
      const img = document.getElementById("game-detail-hero-img");
      if (!hero || !img) return;
      const url = img.getAttribute("src");
      if (!url) return;
      const cached = window.GameDetailView._heroColorCache.get(url);
      if (cached) {
        hero.style.setProperty("--hero-edge", cached);
        return;
      }
      // crossOrigin must be set before src for CORS to apply on canvas readback.
      const sample = new Image();
      sample.crossOrigin = "anonymous";
      sample.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 32; canvas.height = 32;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(sample, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;
          let r = 0, g = 0, b = 0, n = 0;
          // Leftmost (x=0) and rightmost (x=31) columns — 32 rows each.
          for (let y = 0; y < 32; y++) {
            for (const x of [0, 31]) {
              const i = (y * 32 + x) * 4;
              const a = data[i + 3];
              if (a < 16) continue; // skip transparent pixels
              r += data[i]; g += data[i + 1]; b += data[i + 2];
              n++;
            }
          }
          if (n === 0) return;
          const color = `rgb(${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0})`;
          window.GameDetailView._heroColorCache.set(url, color);
          // The hero may have been re-rendered while the sample was in flight;
          // re-resolve the element before applying.
          const cur = document.getElementById("game-detail-hero");
          if (cur) cur.style.setProperty("--hero-edge", color);
        } catch (_) {
          /* SecurityError on getImageData → silent fallback to --game-accent. */
        }
      };
      sample.onerror = () => { /* network/CORS error → silent fallback. */ };
      sample.src = url;
    }

    _renderRecentPlays() {
      // Same `.recent-plays__row` / `__row-inner` chrome the profile uses, so
      // both lists read identical visually. Top line carries "Logger played"
      // here because the game name is implicit on this page.
      return `
        <section class="game-detail__section">
          <h3 class="game-detail__section-title">Your plays</h3>
          ${this._plays.length === 0
            ? `<div class="text-sm opacity-60 p-3">No plays logged yet.</div>`
            : `<ul class="recent-plays">${this._plays.map((p) => this._renderRecentPlayRow(p)).join("")}</ul>`}
        </section>
      `;
    }

    _renderRecentPlayRow(p) {
      const winners = (p.players || []).filter((pl) => pl.is_winner);
      const winnerLabel = winners.map((w) => escape(w.name)).join(", ");
      const playerCount = (p.players || []).length;
      const subParts = [];
      if (winnerLabel) {
        subParts.push(`<span class="recent-plays__winner"><i data-lucide="trophy" class="w-3 h-3"></i> ${winnerLabel}</span>`);
      }
      if (playerCount > 0) {
        subParts.push(`${playerCount} ${playerCount === 1 ? "player" : "players"}`);
      }
      const thumb = p.game_thumbnail || this._game.thumbnail_url;
      // Tapping the box art routes to game-detail (consistent with every
      // other place a boardgame image appears). Tapping anywhere else on
      // the row opens the play.
      const gameNav = `event.stopPropagation();window.router.go('game-detail',{gameId:'${this._game.id}',gameName:'${jsStr(this._game.name || '')}'})`;
      const statusOverlay = this._game.id
        ? `<span class="recent-plays__status">${window.renderStatusTag(this._game.id, this._status || null, { compact: true })}</span>`
        : "";
      return `
        <li class="recent-plays__row" data-play-id="${p.id}">
          <div class="recent-plays__row-inner"
               onclick="window.router.go('play-detail',{playId:'${p.id}'})">
            <div class="recent-plays__thumb">
              ${thumb
                ? `<img src="${escapeAttr(thumb)}" alt="" onclick="${gameNav}" />`
                : `<div class="recent-plays__placeholder"><i data-lucide="dice-6"></i></div>`}
              ${statusOverlay}
            </div>
            <div class="recent-plays__body">
              <div class="recent-plays__top">
                <div class="recent-plays__game">${escape(p.logged_by_name)} played</div>
                <div class="recent-plays__date">${formatDate(p.played_at)}</div>
              </div>
              ${subParts.length ? `<div class="recent-plays__sub">${subParts.join(" · ")}</div>` : ""}
            </div>
          </div>
        </li>
      `;
    }

    _renderBaseGameLink(g) {
      // Expansion → base game banner. The GameDetail Pydantic shape carries
      // base_game_id + base_game_name when the game is an expansion.
      if (!g.is_expansion || !g.base_game_id) return "";
      return `
        <a class="game-detail__base-link" onclick="window.router.go('game-detail',{gameId:'${g.base_game_id}',gameName:'${jsStr(g.base_game_name || '')}'})">
          <i data-lucide="corner-up-left" class="w-3.5 h-3.5"></i>
          <span>Expansion of <strong>${escape(g.base_game_name || "base game")}</strong></span>
        </a>
      `;
    }

    _renderExpansions() {
      if (!this._expansions || this._expansions.length === 0) return "";
      const open = this._expansionsOpen;
      const chevron = open ? "chevron-down" : "chevron-right";
      return `
        <section class="game-detail__section game-detail__section--expansions">
          <button class="collapsible-header"
                  aria-expanded="${open}"
                  onclick="window.gameDetailView._toggleExpansions()">
            <span class="collapsible-header__title">
              <i data-lucide="puzzle" class="w-4 h-4"></i>
              Expansions (${this._expansions.length})
            </span>
            <i data-lucide="${chevron}" class="w-4 h-4 collapsible-header__chev"></i>
          </button>
          ${open ? `
            <ul class="expansion-list">
              ${this._expansions.map((e) => {
                const status = (this._statusMap || {})[e.expansion_game_id] || null;
                return `
                <li class="expansion-list__row"
                    onclick="window.router.go('game-detail',{gameId:'${e.expansion_game_id}',gameName:'${jsStr(e.name || '')}'})"
                    style="--exp-color:${e.color || "#C9922A"}">
                  <span class="expansion-list__dot"></span>
                  ${e.thumbnail_url
                    ? `<img src="${escapeAttr(e.thumbnail_url)}" alt="" class="expansion-list__thumb" loading="lazy" />`
                    : `<div class="expansion-list__thumb expansion-list__thumb--placeholder"><i data-lucide="dice-6"></i></div>`}
                  <div class="expansion-list__body">
                    <div class="expansion-list__name">${escape(e.name)}</div>
                  </div>
                  ${window.renderStatusTag(e.expansion_game_id, status, { size: "xs" })}
                </li>
              `;}).join("")}
            </ul>
          ` : ""}
        </section>
      `;
    }

    _toggleExpansions() {
      this._expansionsOpen = !this._expansionsOpen;
      this.render();
    }

    // ── Reference guide scroll ────────────────────────────────────────────────
    // Returns the section shell containing a mount point. The actual scroll
    // widget is instantiated after innerHTML is set (see _mountGuide).
    _renderReferenceGuide() {
      return `
        <section class="game-detail__section game-detail__section--guide">
          <h3 class="game-detail__section-title">
            <i data-lucide="scroll-text" class="w-4 h-4"></i>
            Reference guide
          </h3>
          <div id="game-detail-guide-mount"></div>
        </section>
      `;
    }

    _mountGuide() {
      const host = document.getElementById("game-detail-guide-mount");
      if (!host || !this._game) return;
      // Single-game view: only the base game id is in scope. No expansion meta
      // needed since there's no merge happening.
      if (!this._guide) {
        this._guide = new window.ReferenceGuideScroll({
          baseGameId: this._game.id,
          gameIds: [this._game.id],
          expansionMeta: { [this._game.id]: { name: this._game.name, color: null } },
          onAfterMutate: () => this.render(),
        });
      } else {
        this._guide.setExpansionMeta({ [this._game.id]: { name: this._game.name, color: null } });
      }
      this._guide.mount(host);
    }

    // Rulebook button. Three shapes:
    //  - has URL → link out, opens in new tab. Admins additionally get a
    //    long-press handler that prompts to delete the URL.
    //  - no URL + admin → "+ Rulebook" button that prompts for a URL and
    //    writes it via the admin endpoint.
    //  - no URL + non-admin → the original greyed-out button.
    _renderRulebookButton(g) {
      const me = window.store && window.store.get && window.store.get("user");
      const isAdmin = !!(me && me.is_admin);
      const url = g.rulebookUrl();
      if (url) {
        const adminAttrs = isAdmin
          ? ` onpointerdown="window.gameDetailView._rulebookHoldStart(event)"
              onpointerup="window.gameDetailView._rulebookHoldEnd(event)"
              onpointercancel="window.gameDetailView._rulebookHoldEnd(event)"
              onpointerleave="window.gameDetailView._rulebookHoldEnd(event)"
              onclick="if(window.gameDetailView._rulebookSuppressClick(event)){return false;}"
              title="Long-press to delete rulebook (admin)"`
          : "";
        return `<a class="btn game-detail__action game-detail__link-btn game-detail__link-btn--rulebook"
                   href="${url}" target="_blank" rel="noopener"${adminAttrs}>
                  <i data-lucide="book-open" class="w-4 h-4"></i> Rulebook
                </a>`;
      }
      if (isAdmin) {
        return `<button class="btn game-detail__action game-detail__link-btn game-detail__link-btn--add"
                        onclick="window.gameDetailView._promptAddRulebook()"
                        title="Set rulebook URL (admin)">
                  <i data-lucide="plus" class="w-4 h-4"></i> Rulebook
                </button>`;
      }
      return `<button class="btn game-detail__action game-detail__link-btn game-detail__link-btn--disabled" disabled
                      title="No rulebook available">
                <i data-lucide="book-open" class="w-4 h-4"></i> Rulebook
              </button>`;
    }

    async _promptAddRulebook() {
      const url = window.prompt("Rulebook URL", "https://");
      if (url == null) return;                    // user hit Cancel
      const trimmed = url.trim();
      if (!trimmed) return;
      if (!/^https?:\/\//i.test(trimmed)) {
        alert("Rulebook URL must start with http:// or https://");
        return;
      }
      try {
        await window.Game.adminSetRulebookUrl(this._game.id, trimmed);
        await this._reload();
      } catch (e) {
        alert(`Failed to set rulebook URL: ${(e && e.message) || e}`);
      }
    }

    async _promptDeleteRulebook() {
      if (!confirm("Delete the rulebook URL for this game?")) return;
      try {
        await window.Game.adminSetRulebookUrl(this._game.id, null);
        await this._reload();
      } catch (e) {
        alert(`Failed to delete rulebook URL: ${(e && e.message) || e}`);
      }
    }

    async _reload() {
      // Bust the cached detail bundle and re-render so the new state shows.
      // _load() reads this.params, so no arg needed — just refresh.
      window.Game.invalidateBundle(this._game.id);
      await this._load();
    }

    // Long-press detector. Starts a 600ms timer on pointerdown; if it fires
    // before pointerup, the delete prompt opens and a "suppress next click"
    // flag is raised so the link doesn't ALSO navigate to the rulebook PDF.
    _rulebookHoldStart(event) {
      this._rulebookHoldTimer = setTimeout(() => {
        this._rulebookHoldTimer = null;
        this._rulebookSuppressNextClick = true;
        this._promptDeleteRulebook();
      }, 600);
    }
    _rulebookHoldEnd(event) {
      if (this._rulebookHoldTimer) {
        clearTimeout(this._rulebookHoldTimer);
        this._rulebookHoldTimer = null;
      }
    }
    _rulebookSuppressClick(event) {
      if (this._rulebookSuppressNextClick) {
        this._rulebookSuppressNextClick = false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    }

    _startPlay() {
      const ps = window.store.get("activePlay") || new window.PlaySession();
      ps.gameId = this._game.id;
      ps.gameSnapshot = {
        id: this._game.id,
        name: this._game.name,
        thumbnail_url: this._game.thumbnail_url,
        rulebook_url: this._game.rulebook_url,
      };
      ps.playMode = this._game.play_mode || null;
      ps.persist();
      window.store.set("activePlay", ps);
      window.router.go("log-play");
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function stripHtml(s) {
    const tmp = document.createElement("div");
    tmp.innerHTML = s || "";
    return tmp.textContent || "";
  }

  // Class-level cache for hero edge colours, keyed by image URL. Survives
  // view re-mounts so a return visit to the same game doesn't re-sample.
  GameDetailView._heroColorCache = new Map();

  window.GameDetailView = GameDetailView;
})();
