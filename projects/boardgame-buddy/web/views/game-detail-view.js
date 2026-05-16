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
      this._error = null;
      this._loading = true;
      this.render();
      try {
        const game = await window.Game.fetch(id);
        // Fan out the secondary fetches in parallel once we know the game.
        // Expansions only fetched for base games (the endpoint returns [] for
        // expansions anyway, but skip the round-trip).
        const [status, plays, expansions] = await Promise.all([
          window.Collection.statusFor(id).catch(() => null),
          window.Play.list({ gameId: id, perPage: 5 }).catch(() => ({ plays: [] })),
          game && !game.is_expansion
            ? window.api.get(`/games/${id}/expansions`).catch(() => [])
            : Promise.resolve([]),
        ]);
        this._game = game;
        this._status = status;
        this._plays = plays.plays || [];
        this._expansions = Array.isArray(expansions) ? expansions : [];
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
          <header class="game-detail__hero">
            <button class="btn btn-ghost btn-sm game-detail__back" onclick="window.router.back('feed')">
              <i data-lucide="arrow-left" class="w-4 h-4"></i>
            </button>
            ${g.image_url || g.thumbnail_url ? `<img src="${g.image_url || g.thumbnail_url}" alt="" />` : ""}
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
              <span class="game-detail__action game-detail__status-slot">
                ${window.renderStatusTag(g.id, status, { size: "lg", addLabel: "Add to collection" })}
              </span>
              ${g.is_expansion ? "" : `
                <button class="btn btn-secondary game-detail__action" onclick="window.gameDetailView._startPlay()">
                  <i data-lucide="play" class="w-4 h-4"></i> Log a play
                </button>
              `}
              <div class="game-detail__links">
                ${g.bggUrl() ? `<a class="btn game-detail__action game-detail__link-btn game-detail__link-btn--bgg"
                                  href="${g.bggUrl()}" target="_blank" rel="noopener">
                  <i data-lucide="external-link" class="w-4 h-4"></i> BGG
                </a>` : ""}
                ${g.rulebookUrl() ? `<a class="btn game-detail__action game-detail__link-btn game-detail__link-btn--rulebook"
                                       href="${g.rulebookUrl()}" target="_blank" rel="noopener">
                  <i data-lucide="book-open" class="w-4 h-4"></i> Rulebook
                </a>` : ""}
              </div>
            </div>
            ${g.description ? `<div class="game-detail__desc">${stripHtml(g.description)}</div>` : ""}
            ${this._renderExpansions()}
            ${this._renderRecentPlays()}
          </div>
        </article>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    _renderRecentPlays() {
      // Match the profile-tab recent-plays card: thumbnail + top row
      // (logger name + date right-aligned) + sub row (trophy winner +
      // player count, dot-separated). The game is fixed on this page,
      // so the primary line carries "who played" instead of the game
      // name that the profile view shows.
      return `
        <section class="game-detail__section">
          <h3 class="game-detail__section-title">Recent plays</h3>
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
      return `
        <li onclick="window.router.go('play-detail',{playId:'${p.id}'})">
          ${thumb
            ? `<img src="${escapeAttr(thumb)}" alt="" />`
            : `<div class="recent-plays__placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="recent-plays__body">
            <div class="recent-plays__top">
              <div class="recent-plays__game">${escape(p.logged_by_name)} played</div>
              <div class="recent-plays__date">${formatDate(p.played_at)}</div>
            </div>
            ${subParts.length ? `<div class="recent-plays__sub">${subParts.join(" · ")}</div>` : ""}
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
      return `
        <section class="game-detail__section game-detail__section--expansions">
          <h3 class="game-detail__section-title">
            <i data-lucide="puzzle" class="w-4 h-4"></i>
            Expansions (${this._expansions.length})
          </h3>
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
                  ${e.chunk_count
                    ? `<div class="expansion-list__meta">${e.chunk_count} reference chunk${e.chunk_count === 1 ? "" : "s"}</div>`
                    : ""}
                </div>
                ${window.renderStatusTag(e.expansion_game_id, status, { size: "xs" })}
              </li>
            `;}).join("")}
          </ul>
        </section>
      `;
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

  window.GameDetailView = GameDetailView;
})();
