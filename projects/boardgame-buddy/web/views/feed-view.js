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
      this.listen("feed", () => this.render());
      this.listen("myCollectionMap", () => this._refreshCollectionData());
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this.render();
      });
      this._statusMap = {};
      this._expansionCounts = {};
      this._refreshCollectionData();
      await this._load({ initial: true });
      this._installScrollObserver();
    }

    async _refreshCollectionData() {
      try {
        const [status, exp] = await Promise.all([
          window.Collection.myStatusMap(),
          window.Collection.myExpansionCountByBaseBggId(),
        ]);
        this._statusMap = status || {};
        this._expansionCounts = exp || {};
      } catch (_) {}
      this.render();
    }

    async onUnmount() {
      this._uninstallScrollObserver();
    }

    _installScrollObserver() {
      if (this._observer) return;
      // Watch a sentinel rendered at the tail of the cards. When it enters the
      // viewport the user has scrolled near the bottom; auto-fetch the next
      // page. IntersectionObserver lives across re-renders because the
      // sentinel keeps its id; we re-observe whenever render() runs.
      this._observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this._loadMore();
        }
      }, { rootMargin: "200px 0px" });
      this._observeSentinel();
    }

    _observeSentinel() {
      if (!this._observer) return;
      const el = document.getElementById("feed-sentinel");
      if (el) this._observer.observe(el);
    }

    _uninstallScrollObserver() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
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

    render() {
      if (!this._page && this._loading) {
        this.container.innerHTML = this._renderSkeleton();
        return;
      }
      const cards = (this._page && this._page.cards) || [];
      // Search pill + avatar moved into the global app header — feed now
      // jumps straight to the resume chip and the card timeline.
      const html = `
        <div class="feed-shell">
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
      // The sentinel div is replaced on every render — re-observe the
      // new node so infinite scroll keeps firing.
      this._observeSentinel();
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
        // Sentinel triggers IntersectionObserver-based auto-load. The button
        // stays in the DOM as a manual fallback (keyboard / a11y) — clicking
        // it just runs _loadMore() too.
        return `
          <div id="feed-sentinel" class="feed-load-more">
            <button class="btn btn-ghost btn-sm" ${this._loading ? "disabled" : ""}
                    onclick="window.feedView._loadMore()">
              ${this._loading ? "Loading more…" : "Load more"}
            </button>
          </div>
        `;
      }
      // Reached the end — let the user know explicitly.
      return `<div class="feed-end opacity-50 text-xs text-center py-3">You've reached the end.</div>`;
    }

    _loadMore() {
      if (this._loading) return;
      if (!this._page || !this._page.next_cursor) return;
      this._load({ cursor: this._page.next_cursor });
    }

    _renderSkeleton() {
      // First-paint loader. Centered vertically + horizontally so it lands in
      // the same spot the splash uses (see `index.html`'s splash <main>:
      // flex/items-center/justify-center/min-h-[60vh]). Keeps the boot →
      // first-feed-paint transition feel like the same loader continuing.
      return `
        <div class="flex flex-col items-center justify-center min-h-[60vh]">
          ${window.buddyLoader({ size: 176, padded: false })}
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
      const tiles = (card.games || []).map((entry) => {
        const status = this._statusMap[entry.game.id] || null;
        const expCount = entry.game.bgg_id ? (this._expansionCounts[entry.game.bgg_id] || 0) : 0;
        return `
        <div class="hot-game-tile" onclick="window.router.go('game-detail',{gameId:'${entry.game.id}',gameName:'${jsStr(entry.game.name || '')}'})">
          ${window.renderStatusTag(entry.game.id, status, { size: "xs" })}
          ${entry.game.thumbnail_url
            ? `<img src="${entry.game.thumbnail_url}" alt="" loading="lazy" />`
            : `<div class="hot-game-tile__placeholder"><i data-lucide="dice-6"></i></div>`
          }
          <div class="hot-game-tile__body">
            <div class="hot-game-tile__name">${escape(entry.game.name)}</div>
            <div class="hot-game-tile__plays">${entry.play_count} plays</div>
          </div>
          ${window.renderExpansionBadge(expCount)}
        </div>`;
      }).join("");
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
      const tiles = (card.games || []).map((entry) => {
        const status = this._statusMap[entry.game.id] || null;
        const expCount = entry.game.bgg_id ? (this._expansionCounts[entry.game.bgg_id] || 0) : 0;
        return `
        <div class="hot-game-tile" onclick="window.router.go('game-detail',{gameId:'${entry.game.id}',gameName:'${jsStr(entry.game.name || '')}'})">
          ${window.renderStatusTag(entry.game.id, status, { size: "xs" })}
          ${entry.game.thumbnail_url
            ? `<img src="${entry.game.thumbnail_url}" alt="" loading="lazy" />`
            : `<div class="hot-game-tile__placeholder"><i data-lucide="dice-6"></i></div>`
          }
          <div class="hot-game-tile__body">
            <div class="hot-game-tile__name">${escape(entry.game.name)}</div>
            <div class="hot-game-tile__plays">${entry.last_played_at ? "Last: " + formatDate(entry.last_played_at) : "Never played"}</div>
          </div>
          ${window.renderExpansionBadge(expCount)}
        </div>`;
      }).join("");
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
