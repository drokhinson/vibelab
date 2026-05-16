// views/feed-view.js — Strava-style chronological feed.
//
// Composition:
//   - Search pill at the top opens GameSearchView
//   - Optional "resume play" chip when a PlaySession draft is active
//   - Mixed cards from /feed: plays (spine) + hot games / suggested buddies /
//     featured-from-collection (first page only)
//   - "Load more" tail when next_cursor is set

(function () {
  class FeedView extends window.View {
    constructor() {
      super("feed");
      this._page = null;
      this._loading = false;
      this._error = null;
    }

    async onMount() {
      this.listen("activePlay", () => this._renderResumeChip());
      this.listen("feed", () => this.render());
      await this._load({ initial: true });
    }

    async _load({ initial = false, cursor = null } = {}) {
      this._loading = true;
      this._error = null;
      if (initial) this._page = null;
      this.render();
      try {
        const data = await window.Feed.fetchPage({ cursor });
        if (cursor && this._page) {
          this._page.cards = [...this._page.cards, ...data.cards];
          this._page.next_cursor = data.next_cursor;
        } else {
          this._page = data;
        }
        window.store.set("feed", this._page);
      } catch (e) {
        this._error = e.message || "Failed to load feed";
      } finally {
        this._loading = false;
        this.render();
      }
    }

    _renderResumeChip() {
      const chip = this.container.querySelector("#feed-resume-chip");
      if (!chip) return;
      const ps = window.store.get("activePlay");
      if (ps && ps.isActive()) {
        chip.classList.remove("hidden");
        const game = ps.gameSnapshot;
        chip.innerHTML = `
          <button class="resume-chip" onclick="window.router.go('log-play')">
            <i data-lucide="rotate-ccw" class="w-4 h-4"></i>
            <span>Resume ${game ? game.name : "play"}</span>
          </button>
        `;
      } else {
        chip.classList.add("hidden");
        chip.innerHTML = "";
      }
      if (window.lucide) window.lucide.createIcons();
    }

    render() {
      if (!this._page && this._loading) {
        this.container.innerHTML = this._renderSkeleton();
        return;
      }
      const cards = (this._page && this._page.cards) || [];
      const html = `
        <div class="feed-shell">
          ${this._renderTopBar()}
          <div id="feed-resume-chip" class="hidden mb-3"></div>
          ${this._error ? `<div class="alert alert-error mb-3">${this._error}</div>` : ""}
          <div class="feed-cards">
            ${cards.length === 0 && !this._loading ? this._renderEmpty() : ""}
            ${cards.map((c) => this._renderCard(c)).join("")}
          </div>
          ${this._renderLoadMore()}
        </div>
      `;
      this.container.innerHTML = html;
      if (window.lucide) window.lucide.createIcons();
      this._renderResumeChip();
    }

    _renderTopBar() {
      const me = window.store.get("user");
      const av = me ? me.display_name : "?";
      const initials = me ? new window.User(me).initials() : "";
      return `
        <header class="feed-topbar">
          <button class="feed-search-pill" onclick="window.router.go('game-search')">
            <i data-lucide="search" class="w-4 h-4"></i>
            <span>Search games</span>
          </button>
          <button class="feed-avatar-btn" onclick="window.router.go('profile-self')" title="My profile">
            <span class="avatar-bubble">${initials}</span>
          </button>
        </header>
      `;
    }

    _renderEmpty() {
      return `
        <div class="feed-empty">
          <img src="assets/illustrations/bgb-loading.svg" alt="" style="width:120px;height:120px;opacity:.75" />
          <h3 class="text-lg font-semibold mt-3">Your feed is quiet</h3>
          <p class="text-sm opacity-70 mt-1">Log a play or add a buddy to fill it up.</p>
          <button class="btn btn-primary btn-sm mt-3" onclick="window.router.go('log-play')">Log a play</button>
        </div>
      `;
    }

    _renderLoadMore() {
      if (!this._page) return "";
      if (this._page.next_cursor) {
        return `
          <div class="feed-load-more">
            <button class="btn btn-ghost btn-sm" ${this._loading ? "disabled" : ""}
                    onclick="window.feedView._loadMore()">
              ${this._loading ? "Loading…" : "Load more"}
            </button>
          </div>
        `;
      }
      return "";
    }

    _loadMore() {
      if (!this._page || !this._page.next_cursor) return;
      this._load({ cursor: this._page.next_cursor });
    }

    _renderSkeleton() {
      const skel = (k) => `
        <div class="play-card play-card--skeleton" key="${k}">
          <div class="skeleton-line skeleton-line--avatar"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line skeleton-line--photo"></div>
        </div>
      `;
      return `
        <div class="feed-shell">
          ${this._renderTopBar()}
          <div class="feed-cards">${[1,2,3].map(skel).join("")}</div>
        </div>
      `;
    }

    _renderCard(card) {
      switch (card.kind) {
        case "play":
          return window.renderPlayCard(card);
        case "hot_games":
          return this._renderHotGamesCard(card);
        case "suggested_buddies":
          return this._renderSuggestedBuddiesCard(card);
        case "featured_from_collection":
          return this._renderFeaturedFromCollectionCard(card);
        default:
          return "";
      }
    }

    _renderHotGamesCard(card) {
      const tiles = (card.games || []).map((entry) => `
        <button class="hot-game-tile" onclick="window.router.go('game-detail',{gameId:'${entry.game.id}'})">
          ${entry.game.thumbnail_url
            ? `<img src="${entry.game.thumbnail_url}" alt="" loading="lazy" />`
            : `<div class="hot-game-tile__placeholder"><i data-lucide="dice-6"></i></div>`
          }
          <div class="hot-game-tile__body">
            <div class="hot-game-tile__name">${escape(entry.game.name)}</div>
            <div class="hot-game-tile__plays">${entry.play_count} plays</div>
          </div>
        </button>
      `).join("");
      return `
        <section class="feed-rail">
          <header class="feed-rail__header">
            <h3><i data-lucide="flame" class="w-4 h-4"></i> Hot this week</h3>
          </header>
          <div class="feed-rail__scroll">${tiles}</div>
        </section>
      `;
    }

    _renderSuggestedBuddiesCard(card) {
      const tiles = (card.suggestions || []).map((s) => `
        <div class="buddy-tile">
          <div class="buddy-tile__avatar"
               onclick="window.router.go('profile-other',{userId:'${s.user_id}'})">
            ${s.avatar_url ? `<img src="${s.avatar_url}" alt="" />` : escape(initialsOf(s.display_name))}
          </div>
          <div class="buddy-tile__name">${escape(s.display_name)}</div>
          <div class="buddy-tile__mutual">${s.mutual_count} mutual</div>
          <button class="btn btn-xs btn-primary mt-1"
                  onclick="window.feedView._addBuddy('${s.user_id}', this)">Add</button>
        </div>
      `).join("");
      return `
        <section class="feed-rail">
          <header class="feed-rail__header">
            <h3><i data-lucide="user-plus" class="w-4 h-4"></i> Buddies you may know</h3>
          </header>
          <div class="feed-rail__scroll">${tiles}</div>
        </section>
      `;
    }

    _renderFeaturedFromCollectionCard(card) {
      const tiles = (card.games || []).map((entry) => `
        <button class="hot-game-tile" onclick="window.router.go('game-detail',{gameId:'${entry.game.id}'})">
          ${entry.game.thumbnail_url
            ? `<img src="${entry.game.thumbnail_url}" alt="" loading="lazy" />`
            : `<div class="hot-game-tile__placeholder"><i data-lucide="dice-6"></i></div>`
          }
          <div class="hot-game-tile__body">
            <div class="hot-game-tile__name">${escape(entry.game.name)}</div>
            <div class="hot-game-tile__plays">${entry.last_played_at ? "Last: " + formatDate(entry.last_played_at) : "Never played"}</div>
          </div>
        </button>
      `).join("");
      return `
        <section class="feed-rail">
          <header class="feed-rail__header">
            <h3><i data-lucide="archive" class="w-4 h-4"></i> Time to revisit</h3>
          </header>
          <div class="feed-rail__scroll">${tiles}</div>
        </section>
      `;
    }

    async _addBuddy(userId, btnEl) {
      try {
        btnEl.disabled = true;
        await window.Buddy.sendRequest(userId);
        btnEl.textContent = "Sent";
      } catch (e) {
        btnEl.disabled = false;
        btnEl.textContent = "Try again";
      }
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function initialsOf(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }
  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  window.FeedView = FeedView;
})();
