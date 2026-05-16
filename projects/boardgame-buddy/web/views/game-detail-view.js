// views/game-detail-view.js — game detail w/ collection toggle + rulebook link.

(function () {
  class GameDetailView extends window.View {
    constructor() {
      super("game-detail");
      this._game = null;
      this._status = null;
      this._plays = [];
      this._loading = false;
      this._error = null;
    }

    async onMount() { await this._load(); }
    async onParamsChange() { await this._load(); }

    async _load() {
      const id = this.params && this.params.gameId;
      if (!id) {
        this._error = "No game specified";
        this.render();
        return;
      }
      this._loading = true;
      this.render();
      try {
        const [game, status, plays] = await Promise.all([
          window.Game.fetch(id),
          window.Collection.statusFor(id).catch(() => null),
          window.Play.list({ gameId: id, perPage: 5 }).catch(() => ({ plays: [] })),
        ]);
        this._game = game;
        this._status = status;
        this._plays = plays.plays || [];
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
            <button class="btn btn-ghost btn-sm" onclick="history.back()"><i data-lucide="arrow-left" class="w-4 h-4"></i></button>
          </header>
          <div class="p-6 alert alert-error">${escape(this._error)}</div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!this._game) {
        this.container.innerHTML = `<div class="p-6 text-center opacity-60">Loading…</div>`;
        return;
      }
      const g = this._game;
      const accent = g.accentColor();
      const status = this._status;
      const next = window.Status.next(status);

      this.container.innerHTML = `
        <article class="game-detail" style="--game-accent:${accent}">
          <header class="game-detail__hero">
            <button class="btn btn-ghost btn-sm game-detail__back" onclick="history.back()">
              <i data-lucide="arrow-left" class="w-4 h-4"></i>
            </button>
            ${g.image_url || g.thumbnail_url ? `<img src="${g.image_url || g.thumbnail_url}" alt="" />` : ""}
            <div class="game-detail__hero-veil"></div>
          </header>
          <div class="game-detail__body">
            <h1 class="game-detail__name font-display">${escape(g.name)}</h1>
            <div class="game-detail__meta">
              ${g.year_published ? `<span>${g.year_published}</span>` : ""}
              ${g.playerRangeText() ? `<span>${g.playerRangeText()}</span>` : ""}
              ${g.playTimeText() ? `<span>${g.playTimeText()}</span>` : ""}
            </div>
            <div class="game-detail__actions">
              <button class="btn btn-primary" onclick="window.gameDetailView._toggleStatus('${next}')">
                <i data-lucide="${window.Status.icon(next)}" class="w-4 h-4"></i>
                ${status ? `Move to ${window.Status.label(next)}` : `Add to ${window.Status.label(next)}`}
              </button>
              <button class="btn btn-secondary" onclick="window.gameDetailView._startPlay()">
                <i data-lucide="play" class="w-4 h-4"></i> Log a play
              </button>
              ${g.bggUrl() ? `<a class="btn btn-ghost btn-sm" href="${g.bggUrl()}" target="_blank" rel="noopener">
                <i data-lucide="external-link" class="w-4 h-4"></i> BGG
              </a>` : ""}
              ${g.rulebookUrl() ? `<a class="btn btn-ghost btn-sm" href="${g.rulebookUrl()}" target="_blank" rel="noopener">
                <i data-lucide="book-open" class="w-4 h-4"></i> Rulebook
              </a>` : ""}
            </div>
            ${g.description ? `<div class="game-detail__desc">${stripHtml(g.description)}</div>` : ""}
            <section class="game-detail__plays">
              <h3>Recent plays</h3>
              ${this._plays.length === 0
                ? `<div class="text-sm opacity-60 p-3">No plays logged yet.</div>`
                : `<ul class="recent-plays">${this._plays.map((p) => `
                    <li>
                      <div class="recent-plays__body">
                        <div class="recent-plays__game">${escape(p.logged_by_name)}</div>
                        <div class="recent-plays__when">${formatDate(p.played_at)}</div>
                      </div>
                    </li>
                  `).join("")}</ul>`}
            </section>
          </div>
        </article>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    async _toggleStatus(nextStatus) {
      const id = this._game.id;
      try {
        if (this._status && nextStatus === "none") {
          // Need item id to delete — fetch via list. For v1, just call
          // /collection upsert with the "remove" path on the backend.
          await window.api.del(`/collection/by-game/${id}`).catch(async () => {
            // Fallback: try the legacy POST → it will treat the missing row.
          });
          this._status = null;
        } else if (nextStatus === "none") {
          this._status = null;
        } else {
          await window.Collection.add(id, nextStatus);
          this._status = nextStatus;
        }
      } catch (e) {
        alert(e.message || "Failed to update collection");
      } finally {
        this.render();
      }
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
