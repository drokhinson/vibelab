// views/profile-self-view.js — current user's Strava-style profile.

(function () {
  class ProfileSelfView extends window.View {
    constructor() {
      super("profile-self");
      this._stats = null;
      this._collection = null;
      this._error = null;
      this._loading = false;
    }

    async onMount() {
      this.listen("user", () => this.render());
      await this._load();
    }

    async _load() {
      this._loading = true;
      this.render();
      try {
        const [stats, collection] = await Promise.all([
          window.Stats.for(window.store.get("user").id),
          window.api.get("/collection", { per_page: 50, page: 1 }).catch(() => null),
        ]);
        this._stats = stats;
        this._collection = collection;
      } catch (e) {
        this._error = e.message || "Failed to load profile";
      } finally {
        this._loading = false;
        this.render();
      }
    }

    render() {
      const me = window.store.get("user");
      if (!me) {
        this.container.innerHTML = `<div class="p-6 text-center">Not signed in.</div>`;
        return;
      }
      const s = this._stats ? window.Stats.format(this._stats) : null;
      const owned = ((this._collection && this._collection.items) || [])
        .filter((it) => it.status === "owned");

      this.container.innerHTML = `
        <section class="profile-header">
          <div class="profile-header__avatar avatar-bubble avatar-bubble--lg">${new window.User(me).initials()}</div>
          <h2 class="profile-header__name font-display">${escape(me.display_name)}</h2>
          <p class="profile-header__since">Buddy since ${formatDate(me.created_at)}</p>
          <div class="profile-header__actions">
            <button class="btn btn-sm btn-ghost" onclick="window.router.go('buddies')">
              <i data-lucide="users" class="w-4 h-4"></i> Buddies
            </button>
            ${me.is_admin ? `<button class="btn btn-sm btn-ghost" onclick="window.router.go('admin')"><i data-lucide="shield-check" class="w-4 h-4"></i> Admin</button>` : ""}
            <button class="btn btn-sm btn-ghost" onclick="window.handleLogout()">
              <i data-lucide="log-out" class="w-4 h-4"></i> Log out
            </button>
          </div>
        </section>

        <section class="profile-stats">
          ${s ? this._statRow(s) : `<div class="text-center p-6 opacity-60">Loading stats…</div>`}
        </section>

        <section class="profile-section">
          <header class="profile-section__header">
            <h3><i data-lucide="library-big" class="w-4 h-4"></i> My collection</h3>
            <button class="btn btn-ghost btn-xs" onclick="window.router.go('game-search')">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> Add
            </button>
          </header>
          ${owned.length === 0
            ? `<div class="profile-empty">No owned games yet — tap “Add” to search.</div>`
            : `<div class="profile-collection-grid">${owned.slice(0, 12).map(this._renderCollectionTile).join("")}</div>`}
        </section>

        <section class="profile-section">
          <header class="profile-section__header">
            <h3><i data-lucide="history" class="w-4 h-4"></i> Recent plays</h3>
          </header>
          <div id="profile-recent-plays" class="text-sm opacity-60">Loading…</div>
        </section>

        <footer class="bgg-attribution-card">
          <h3>Data Sources</h3>
          <p>Game data and box art come from
            <a href="https://boardgamegeek.com" target="_blank" rel="noopener noreferrer">BoardGameGeek</a>
            via the BGG XML API.</p>
          <a class="bgg-attribution-card__logo" href="https://boardgamegeek.com" target="_blank" rel="noopener noreferrer">
            <img src="assets/credits/bgg-logo.svg" alt="Powered by BoardGameGeek" height="36" />
          </a>
        </footer>
      `;
      if (window.lucide) window.lucide.createIcons();
      this._loadRecentPlays();
    }

    async _loadRecentPlays() {
      const el = document.getElementById("profile-recent-plays");
      if (!el) return;
      try {
        const data = await window.Play.list({ perPage: 5, page: 1 });
        const items = (data && data.plays) || [];
        if (items.length === 0) {
          el.innerHTML = `<div class="profile-empty">No plays logged yet.</div>`;
          return;
        }
        el.innerHTML = `<ul class="recent-plays">${items.map((p) => `
          <li onclick="window.router.go('game-detail',{gameId:'${p.game_id}'})">
            ${p.game_thumbnail ? `<img src="${p.game_thumbnail}" alt="" />` : `<div class="recent-plays__placeholder"><i data-lucide="dice-6"></i></div>`}
            <div class="recent-plays__body">
              <div class="recent-plays__game">${escape(p.game_name)}</div>
              <div class="recent-plays__when">${formatDate(p.played_at)}</div>
            </div>
          </li>
        `).join("")}</ul>`;
        if (window.lucide) window.lucide.createIcons();
      } catch (e) {
        el.innerHTML = `<div class="text-error text-sm">${escape(e.message || "Failed to load")}</div>`;
      }
    }

    _statRow(s) {
      const row = (k, v, label) => `
        <div class="profile-stat">
          <div class="profile-stat__value">${v}</div>
          <div class="profile-stat__label">${label}</div>
        </div>
      `;
      return `
        <div class="profile-stats__grid">
          ${row("plays", s.plays, "Plays")}
          ${row("games", s.games, "Games")}
          ${row("wins", s.wins, "Wins")}
          ${row("hours", s.hours, "Hours")}
        </div>
      `;
    }

    _renderCollectionTile(item) {
      const g = item.game || {};
      return `
        <button class="collection-tile" onclick="window.router.go('game-detail',{gameId:'${g.id}'})">
          ${g.thumbnail_url
            ? `<img src="${g.thumbnail_url}" alt="" loading="lazy" />`
            : `<div class="collection-tile__placeholder"><i data-lucide="dice-6"></i></div>`}
          <div class="collection-tile__name">${escape(g.name || "Unknown")}</div>
        </button>
      `;
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

  window.ProfileSelfView = ProfileSelfView;
})();
