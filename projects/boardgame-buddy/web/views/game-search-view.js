// views/game-search-view.js — unified search with optional BGG extension.

(function () {
  class GameSearchView extends window.View {
    constructor() {
      super("game-search");
      this._q = "";
      this._results = null;
      this._loading = false;
      this._bggLoading = false;
    }

    onMount() {
      this.render();
      const input = document.getElementById("search-input");
      if (input) input.focus();
    }

    render() {
      this.container.innerHTML = `
        <header class="search-topbar">
          <button class="btn btn-ghost btn-sm" onclick="history.back()">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <form class="search-form" onsubmit="window.gameSearchView._submit(event)">
            <i data-lucide="search" class="w-4 h-4 search-form__icon"></i>
            <input id="search-input" type="text" placeholder="Search games"
                   value="${escapeAttr(this._q)}" class="search-form__input" />
            ${this._q
              ? `<button type="button" class="search-form__clear" onclick="window.gameSearchView._clear()">
                   <i data-lucide="x" class="w-3.5 h-3.5"></i>
                 </button>` : ""}
          </form>
        </header>
        <div class="search-results">
          ${this._renderBody()}
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    _renderBody() {
      if (this._loading && !this._results) return `<div class="p-6 text-center opacity-60">Searching…</div>`;
      if (!this._results) return `<div class="p-6 text-center opacity-60">Type a game name to search.</div>`;
      const hits = this._results.results || [];
      const bgg  = this._results.bgg_results || [];
      if (hits.length === 0 && bgg.length === 0 && !this._loading) {
        return `
          <div class="search-empty">
            <p>No matches in your library.</p>
            <button class="btn btn-primary" ${this._bggLoading ? "disabled" : ""} onclick="window.gameSearchView._searchBgg()">
              ${this._bggLoading ? "Searching BGG…" : "Search BoardGameGeek for more"}
            </button>
          </div>
        `;
      }
      return `
        <ul class="search-list">
          ${hits.map(this._renderHit).join("")}
        </ul>
        ${!this._results.bgg_searched
          ? `<div class="search-extend">
               <button class="btn btn-ghost btn-sm" ${this._bggLoading ? "disabled" : ""} onclick="window.gameSearchView._searchBgg()">
                 ${this._bggLoading ? "Searching BGG…" : "Search BoardGameGeek for more"}
               </button>
             </div>`
          : (bgg.length > 0
              ? `<div class="search-bgg-section">
                   <h4 class="search-bgg-heading">From BoardGameGeek</h4>
                   <ul class="search-list">
                     ${bgg.map(this._renderBggHit).join("")}
                   </ul>
                 </div>`
              : `<div class="text-sm opacity-60 p-3">No additional BGG matches.</div>`)}
      `;
    }

    _renderHit(hit) {
      const g = hit.game;
      const status = hit.collection_status;
      const meta = [g.year_published, g.min_players && `${g.min_players}${g.max_players && g.max_players !== g.min_players ? "–" + g.max_players : ""}P`].filter(Boolean).join(" · ");
      return `
        <li class="search-hit" onclick="window.router.go('game-detail',{gameId:'${g.id}'})">
          ${g.thumbnail_url ? `<img src="${g.thumbnail_url}" alt="" loading="lazy" />` : `<div class="search-hit__placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="search-hit__body">
            <div class="search-hit__name">${escapeHtml(g.name)}</div>
            <div class="search-hit__meta">${escapeHtml(meta)}</div>
          </div>
          ${status ? `<span class="status-badge status-badge--${status}">${status}</span>` : ""}
        </li>
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

    _clear() {
      this._q = "";
      this._results = null;
      this.render();
      const input = document.getElementById("search-input");
      if (input) input.focus();
    }

    async _submit(event) {
      event.preventDefault();
      const input = document.getElementById("search-input");
      this._q = input.value.trim();
      if (!this._q) {
        this._results = null;
        this.render();
        return;
      }
      this._loading = true;
      this.render();
      try {
        this._results = await window.Search.run(this._q);
      } catch (e) {
        this._results = { results: [], bgg_results: [], bgg_searched: false };
      } finally {
        this._loading = false;
        this.render();
      }
    }

    async _searchBgg() {
      if (!this._q) return;
      this._bggLoading = true;
      this.render();
      try {
        this._results = await window.Search.run(this._q, { includeBgg: true });
      } catch (e) {
        // leave _results as-is so any prior hits stay visible
      } finally {
        this._bggLoading = false;
        this.render();
      }
    }

    async _importBgg(bggId) {
      // Defer to the existing import endpoint. If the game is already in the
      // DB the FE will route to its detail view; otherwise it imports first.
      try {
        const data = await window.api.post(`/games/import-bgg`, { bgg_id: bggId });
        if (data && data.id) {
          window.router.go("game-detail", { gameId: data.id });
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

  window.GameSearchView = GameSearchView;
})();
