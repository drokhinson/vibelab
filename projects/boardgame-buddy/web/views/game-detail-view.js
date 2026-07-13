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
        this.refreshIcons();
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

      const heroSrc = g.image_url || g.thumbnail_url;
      this.container.innerHTML = `
        <article class="game-detail" style="--game-accent:${accent}">
          <button class="btn btn-ghost btn-sm game-detail__back" onclick="window.router.back('feed')" aria-label="Back">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <header class="game-detail__cover">
            <div class="game-detail__polaroid">
              <div class="game-detail__polaroid-photo${heroSrc ? "" : " game-detail__polaroid-photo--empty"}">
                ${heroSrc ? `<img src="${heroSrc}" alt="" />` : `<i data-lucide="dice-6" class="w-10 h-10"></i>`}
              </div>
              ${g.year_published ? `<div class="game-detail__polaroid-cap">${g.year_published}</div>` : `<div class="game-detail__polaroid-cap">&nbsp;</div>`}
              <span class="game-detail__polaroid-status">
                ${window.renderStatusTag(g.id, status, { size: "lg", addLabel: "Add" })}
              </span>
            </div>
          </header>
          <div class="game-detail__body">
            <h1 class="game-detail__name font-display">${escape(g.name)}</h1>
            ${this._renderBaseGameLink(g)}
            <div class="game-detail__meta">
              ${g.is_expansion ? `<span class="game-detail__meta-pill"><i data-lucide="puzzle" class="w-3.5 h-3.5"></i> Expansion</span>` : ""}
              ${g.playerRangeText() ? `<span class="game-detail__meta-pill"><i data-lucide="users" class="w-3.5 h-3.5"></i> ${g.playerRangeText()}</span>` : ""}
              ${g.playTimeText() ? `<span class="game-detail__meta-pill"><i data-lucide="clock" class="w-3.5 h-3.5"></i> ${g.playTimeText()}</span>` : ""}
              ${g.play_mode === "cooperative" ? `<span class="game-detail__meta-pill"><i data-lucide="handshake" class="w-3.5 h-3.5"></i> Co-op</span>` : ""}
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
      this.refreshIcons();
      this._mountGuide();
    }

    _renderRecentPlays() {
      // Mirror the Feed's polaroid reel — same `.play-session__scroll`
      // wrapper + `window.renderPlayCard` so tap-to-flip and the nested
      // navigation (game-link, game-thumb, maximize button) all work
      // identically. The bundle's recent_plays shape differs from the feed
      // card shape, so _toFeedPlayCard adapts each row.
      //
      // Force the strip variant by passing a session count >1 — on Game
      // Detail we always want the compact horizontal-scroll size, even
      // when there's only a single play, so all cards stay uniform.
      if (!this._plays || this._plays.length === 0) return "";
      const cards = this._plays
        .map((p) => window.renderPlayCard({ ...this._toFeedPlayCard(p), __sessionPlayCount: 2 }))
        .join("");
      return `
        <section class="game-detail__section">
          <h3 class="game-detail__section-title">
            <i data-lucide="dice-6" class="w-4 h-4"></i>
            Recent plays
          </h3>
          <div class="play-session__scroll game-detail__plays-scroll">${cards}</div>
        </section>
      `;
    }

    // Adapter: bundle's recent_plays row → feed card shape consumed by
    // window.renderPlayCard. duration_minutes / full notes live on the BACK
    // of the card, which hydrates via window.Play.get(play_id) on first flip,
    // so missing back-face fields self-heal.
    _toFeedPlayCard(p) {
      const players = p.players || [];
      const winners = players.filter((pl) => pl.is_winner).map((w) => w.name);
      return {
        kind: "play",
        play_id: p.id,
        played_at: p.played_at,
        photo_url: p.photo_url || null,
        notes: p.notes || null,
        play_mode: p.play_mode || "competitive",
        winner_display_name: winners.length ? winners.join(", ") : null,
        participant_count: players.length,
        players,
        participants: players.map((pl) => ({ user_id: pl.user_id, display_name: pl.name })),
        user: p.logged_by_id ? { id: p.logged_by_id, display_name: p.logged_by_name } : null,
        game: {
          id: this._game.id,
          name: this._game.name,
          thumbnail_url: p.game_thumbnail || this._game.thumbnail_url,
          image_url: this._game.image_url,
          theme_color: this._game.accentColor(),
        },
      };
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
      return `
        <section class="game-detail__section game-detail__section--expansions">
          <h3 class="game-detail__section-title">
            <i data-lucide="puzzle" class="w-4 h-4"></i>
            Expansions (${this._expansions.length})
          </h3>
          <div class="expansion-reel">
            ${this._expansions.map((e) => {
              const status = (this._statusMap || {})[e.expansion_game_id] || null;
              const owned = status === "owned" || status === "played" || status === "wishlist";
              return `
                <article class="expansion-polaroid"
                         onclick="window.router.go('game-detail',{gameId:'${e.expansion_game_id}',gameName:'${jsStr(e.name || '')}'})">
                  <div class="expansion-polaroid__photo">
                    ${e.thumbnail_url
                      ? `<img src="${escapeAttr(e.thumbnail_url)}" alt="" loading="lazy" />`
                      : `<div class="expansion-polaroid__placeholder"><i data-lucide="dice-6"></i></div>`}
                    ${owned ? `<span class="expansion-polaroid__check"><i data-lucide="check" class="w-3.5 h-3.5"></i></span>` : ""}
                  </div>
                  <div class="expansion-polaroid__cap">${escape(e.name)}</div>
                </article>
              `;
            }).join("")}
          </div>
        </section>
      `;
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
          gameImage: this._game.image_url || this._game.thumbnail_url || null,
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
        const status = e && e.status ? ` (HTTP ${e.status})` : "";
        alert(`Failed to set rulebook URL${status}: ${(e && e.message) || e}`);
      }
    }

    async _promptDeleteRulebook() {
      if (!confirm("Delete the rulebook URL for this game?")) return;
      try {
        await window.Game.adminSetRulebookUrl(this._game.id, null);
        await this._reload();
      } catch (e) {
        // 404 on a delete usually means the URL is already gone (game record
        // dropped, or the admin endpoint isn't deployed on this environment
        // yet). Refresh the view so the user sees the current state instead
        // of a scary error toast — the no-rulebook state is the goal anyway.
        if (e && e.status === 404) {
          console.warn("Rulebook delete 404 — refreshing view", e);
          await this._reload();
          return;
        }
        const status = e && e.status ? ` (HTTP ${e.status})` : "";
        alert(`Failed to delete rulebook URL${status}: ${(e && e.message) || e}`);
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

    async _startPlay() {
      // Tap-from-game-detail starts a fresh host session with this game
      // pre-filled and drops the user straight into the Gather screen.
      // If a live lobby is already open (has a server code), confirm
      // before abandoning it — otherwise the local-only draft is safe
      // to overwrite silently.
      const existing = window.PlaySession.load();
      if (existing && existing.code) {
        const ok = await window.PolaroidPopup.confirm({
          title: "Start a new session?",
          body: "Your in-progress lobby will be closed. This can't be undone.",
          confirmLabel: "Start new",
          cancelLabel: "Keep current",
        });
        if (!ok) return;
        // Fire-and-forget: tell the server to abandon the old lobby so
        // joiners aren't stuck staring at a dead session.
        const oldCode = existing.code;
        existing.clear();
        window.PlaySession.advancePhase(oldCode, "abandoned").catch(() => {});
      } else if (existing) {
        existing.clear();
      }
      const ps = new window.PlaySession();
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
      // play-flow-view.onMount calls _ensureLobbyOpen() which creates the
      // server-side lobby on first paint, so we don't need to do it here.
      window.router.go("play-flow");
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

  window.GameDetailView = GameDetailView;
})();
