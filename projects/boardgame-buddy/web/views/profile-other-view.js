// views/profile-other-view.js — public view of another user's profile.
//
// Header + buddy-relation button + stats strip, then two tabs:
//   Game Collection | Recent Plays
// Both panels reuse the /collection/grid and /plays endpoints with
// ?user_id=<target> so the surface tracks the same UX as the self profile.

(function () {
  const PLAYS_PER_PAGE = 10;
  const COLLECTION_PER_PAGE = 12;
  const TAB_COLLECTION = "collection";
  const TAB_PLAYS = "plays";

  class ProfileOtherView extends window.View {
    constructor() {
      super("profile-other");
      this._activeTab = TAB_COLLECTION;
      this._profile = null;
      this._stats = null;
      this._error = null;

      this._collectionItems = [];
      this._collectionTotal = 0;
      this._collectionPage = 1;
      this._collectionLoading = false;
      this._collectionError = null;

      this._recentPlays = [];
      this._recentPlaysTotal = 0;
      this._recentPlaysPage = 1;
      this._recentPlaysLoading = false;
      this._recentPlaysError = null;
      this._recentPlaysLoaded = false;
    }

    async onMount() {
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
      await this._load();
    }
    async onParamsChange() { await this._load(); }

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

    _userId() {
      return this.params && this.params.userId;
    }

    async _load() {
      const userId = this._userId();
      if (!userId) {
        this._error = "No user specified";
        this.render();
        return;
      }
      // Reset section state when the target user changes.
      this._activeTab = TAB_COLLECTION;
      this._collectionItems = [];
      this._collectionTotal = 0;
      this._collectionPage = 1;
      this._recentPlays = [];
      this._recentPlaysTotal = 0;
      this._recentPlaysPage = 1;
      this._recentPlaysLoaded = false;
      // /profile/bundle covers stats + collection-grid for the target user in
      // one round trip; User.fetch is still needed for the display-name /
      // avatar / buddy-relation metadata the bundle doesn't carry. Both
      // requests fire in parallel and hydrate their blocks independently.
      this._collectionLoading = true;
      this.render();
      const profilePromise = window.User.fetch(userId)
        .then((p) => { this._profile = p; this.render(); })
        .catch((e) => { this._error = e.message || "Failed to load profile"; this.render(); });
      const bundlePromise = window.Profile.bundle(userId, { colPerPage: COLLECTION_PER_PAGE, playsPerPage: PLAYS_PER_PAGE })
        .then((b) => { this._hydrateFromBundle(b); })
        .catch((e) => {
          // Fall back to the legacy per-call path so the panel still loads
          // if the bundle endpoint regresses.
          if (window.console) console.warn("profile bundle failed, falling back", e);
          return Promise.all([
            window.Stats.for(userId).then((s) => { this._stats = s; this.render(); }).catch(() => {}),
            this._loadCollection(),
          ]);
        });
      await Promise.all([profilePromise, bundlePromise]);
    }

    _hydrateFromBundle(b) {
      if (!b) return;
      this._stats = b.stats || null;
      // The collection panel only renders the owned page on Profile Other —
      // the existing UI doesn't expose wishlist/played for other users.
      this._collectionItems = b.owned_page || [];
      this._collectionTotal = b.owned_total || 0;
      this._collectionPage = 1;
      this._collectionLoading = false;
      // Recent plays are tab-loaded on demand; seed page 1 so the tab paints
      // instantly when the user clicks it.
      this._recentPlays = b.recent_plays || [];
      this._recentPlaysTotal = b.recent_plays_total || 0;
      this._recentPlaysPage = 1;
      this._recentPlaysLoaded = true;
      // Seed the viewer's collection map / expansion counts so tile pills
      // render the right state without a separate /collection round trip.
      if (b.status_map && b.expansion_counts) {
        window.Collection.seedFromBundle(b.status_map, b.expansion_counts);
        this._statusMap = b.status_map;
        this._expansionCounts = b.expansion_counts;
      }
      this.render();
    }

    async _loadCollection() {
      this._collectionLoading = true;
      this._collectionError = null;
      this.render();
      try {
        const qs = new URLSearchParams({
          user_id: this._userId(),
          page: String(this._collectionPage),
          per_page: String(COLLECTION_PER_PAGE),
          exclude_expansions: "true",
        });
        const data = await window.api.get("/collection/grid?" + qs.toString());
        this._collectionItems = (data && data.items) || [];
        this._collectionTotal = (data && data.total) || 0;
      } catch (e) {
        this._collectionError = e.message || "Failed to load";
        this._collectionItems = [];
        this._collectionTotal = 0;
      } finally {
        this._collectionLoading = false;
        this.render();
      }
    }

    async _loadRecentPlays() {
      this._recentPlaysLoading = true;
      this._recentPlaysError = null;
      this.render();
      try {
        const data = await window.Play.list({
          userId: this._userId(),
          page: this._recentPlaysPage,
          perPage: PLAYS_PER_PAGE,
        });
        const fresh = (data && data.plays) || [];
        this._recentPlaysTotal = (data && data.total) || 0;
        this._recentPlays = this._recentPlaysPage === 1 ? fresh : [...this._recentPlays, ...fresh];
      } catch (e) {
        this._recentPlaysError = e.message || "Failed to load";
      } finally {
        this._recentPlaysLoading = false;
        this._recentPlaysLoaded = true;
        this.render();
      }
    }

    render() {
      if (this._error) {
        this.container.innerHTML = `
          <div class="p-6">
            <button class="btn btn-ghost btn-sm mb-3" onclick="window.router.back('feed')">
              <i data-lucide="arrow-left" class="w-4 h-4"></i> Back
            </button>
            <div class="alert alert-error">${escape(this._error)}</div>
          </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }
      if (!this._profile) {
        this.container.innerHTML = window.buddyLoader({ size: 120 });
        return;
      }
      const p = this._profile;
      const s = this._stats ? window.Stats.format(this._stats) : null;
      this.container.innerHTML = `
        <header class="profile-other__top">
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
        </header>

        <section class="profile-header profile-header--row">
          <div class="profile-id">
            ${window.BgbBadge.render({ avatar: p.avatar, displayName: p.display_name, size: "md", extraClass: "profile-id__avatar" })}
            <div class="profile-id__text">
              <h2 class="profile-id__name font-display">${escape(p.display_name)}</h2>
              ${p.username ? `
                <div class="profile-id__handle">
                  <i data-lucide="at-sign" class="w-3.5 h-3.5"></i>
                  <span class="profile-id__handle-value">${escape(p.username)}</span>
                </div>
              ` : ""}
            </div>
          </div>
          <div class="profile-header__actions">
            ${this._renderRelationButton(p)}
          </div>
        </section>

        <section class="profile-stats">
          ${s ? this._statRow(s) : window.buddyLoader({ size: 72, label: "Loading stats" })}
        </section>

        <nav class="profile-tabs" role="tablist">
          ${this._renderTab(TAB_COLLECTION, "Game Collection")}
          ${this._renderTab(TAB_PLAYS,      "Recent Plays")}
        </nav>

        <div id="profile-other-tab-body" class="profile-tab-body"></div>
      `;
      this._renderActiveTab();
      if (window.lucide) window.lucide.createIcons();
    }

    _renderTab(id, label) {
      const isActive = this._activeTab === id;
      return `
        <button class="profile-tab ${isActive ? "is-active" : ""}"
                role="tab" aria-selected="${isActive}"
                onclick="window.profileOtherView._switchTab('${id}')">
          ${label}
        </button>
      `;
    }

    _renderActiveTab() {
      const body = document.getElementById("profile-other-tab-body");
      if (!body) return;
      if (this._activeTab === TAB_COLLECTION) {
        body.innerHTML = this._renderCollectionPanel();
      } else {
        body.innerHTML = this._renderRecentPlaysPanel();
      }
      if (window.lucide) window.lucide.createIcons();
    }

    async _switchTab(id) {
      if (this._activeTab === id) return;
      this._activeTab = id;
      if (id === TAB_PLAYS && !this._recentPlaysLoaded) {
        this._recentPlaysPage = 1;
        this._loadRecentPlays();
        return;
      }
      this.render();
    }

    _statRow(s) {
      const fav = s.favorite;
      const favName = fav ? fav.name : "—";
      const favClick = fav ? `onclick="window.router.go('game-detail',{gameId:'${fav.id}',gameName:'${jsStr(fav.name || '')}'})"` : "";
      return `
        <div class="profile-stats__grid">
          <div class="profile-stat">
            <div class="profile-stat__value">${s.games}</div>
            <div class="profile-stat__label">Played Games</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat__value">${s.owned}</div>
            <div class="profile-stat__label">Owned Games</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat__value">${s.wins}</div>
            <div class="profile-stat__label">Wins</div>
          </div>
          <div class="profile-stat profile-stat--fav" ${favClick}>
            <div class="profile-stat__value profile-stat__value--text" title="${escape(favName)}">${escape(favName)}</div>
            <div class="profile-stat__label">Favorite</div>
          </div>
        </div>
      `;
    }

    _renderRelationButton(p) {
      if (p.is_buddy) {
        return `<button class="btn btn-sm btn-ghost" disabled><i data-lucide="check" class="w-4 h-4"></i> Buddies</button>`;
      }
      if (p.has_pending_request) {
        if (p.pending_request_direction === "incoming") {
          return `<button class="btn btn-sm btn-primary" onclick="window.profileOtherView._accept('${p.id}')"><i data-lucide="user-check" class="w-4 h-4"></i> Accept request</button>`;
        }
        return `<button class="btn btn-sm btn-ghost" disabled><i data-lucide="clock" class="w-4 h-4"></i> Request sent</button>`;
      }
      return `<button class="btn btn-sm btn-primary" onclick="window.profileOtherView._addBuddy('${p.id}')"><i data-lucide="user-plus" class="w-4 h-4"></i> Buddy up</button>`;
    }

    async _addBuddy(userId) {
      try { await window.Buddy.sendRequest(userId); } catch (_) {}
      await this._load();
    }

    async _accept(otherUserId) {
      try {
        const requests = await window.Buddy.requests();
        const inc = (requests.incoming || []).find((r) => r.other_user_id === otherUserId);
        if (inc) await window.Buddy.accept(inc.id);
      } catch (_) {}
      await this._load();
    }

    // ── Collection panel ──────────────────────────────────────────────────────

    _renderCollectionPanel() {
      const totalPages = Math.max(1, Math.ceil(this._collectionTotal / COLLECTION_PER_PAGE));
      const ownedExp = (this._stats && this._stats.owned_expansions) || 0;
      const subtitle = ownedExp > 0
        ? `${this._collectionTotal} games · ${ownedExp} expansion${ownedExp === 1 ? "" : "s"}`
        : `${this._collectionTotal} games`;
      return `
        <div class="profile-panel">
          <div class="profile-panel__subtitle">${escape(subtitle)}</div>
          ${this._renderCollectionBody()}
          ${this._renderCollectionPager(totalPages)}
        </div>
      `;
    }

    _renderCollectionBody() {
      if (this._collectionError) {
        return `<div class="alert alert-error text-sm">${escape(this._collectionError)}</div>`;
      }
      if (this._collectionLoading && this._collectionItems.length === 0) {
        return window.buddyLoader({ size: 88 });
      }
      if (this._collectionItems.length === 0) {
        return `<div class="profile-empty">${escape(this._profile.display_name)} doesn't own any games yet.</div>`;
      }
      return `
        <div class="profile-collection-grid">
          ${this._collectionItems.map((it) => {
            const g = it.game || {};
            const status = this._statusMap[g.id] || null;
            const expCount = g.bgg_id ? (this._expansionCounts[g.bgg_id] || 0) : 0;
            return `
              <div class="collection-tile" onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || '')}'})">
                ${window.renderStatusTag(g.id, status, { size: "xs" })}
                ${g.thumbnail_url
                  ? `<img src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" />`
                  : `<div class="collection-tile__placeholder"><i data-lucide="dice-6"></i></div>`}
                <div class="collection-tile__name">${escape(g.name || "Unknown")}</div>
                ${window.renderExpansionBadge(expCount)}
              </div>
            `;
          }).join("")}
        </div>
      `;
    }

    _renderCollectionPager(totalPages) {
      if (totalPages <= 1) return "";
      return `
        <nav class="search-pager">
          <button class="btn btn-ghost btn-xs" ${this._collectionPage <= 1 ? "disabled" : ""}
                  onclick="window.profileOtherView._goCollectionPage(${this._collectionPage - 1})">
            <i data-lucide="chevron-left" class="w-3.5 h-3.5"></i> Prev
          </button>
          <span class="text-xs opacity-60">Page ${this._collectionPage} of ${totalPages}</span>
          <button class="btn btn-ghost btn-xs" ${this._collectionPage >= totalPages ? "disabled" : ""}
                  onclick="window.profileOtherView._goCollectionPage(${this._collectionPage + 1})">
            Next <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
          </button>
        </nav>
      `;
    }

    _goCollectionPage(n) {
      this._collectionPage = n;
      this._loadCollection();
    }

    // ── Recent plays panel ────────────────────────────────────────────────────

    _renderRecentPlaysPanel() {
      return `
        <div class="profile-panel">
          ${this._renderRecentPlaysBody()}
          ${this._renderRecentPlaysLoadMore()}
        </div>
      `;
    }

    _renderRecentPlaysBody() {
      if (this._recentPlaysError) {
        return `<div class="text-error text-sm">${escape(this._recentPlaysError)}</div>`;
      }
      if (!this._recentPlaysLoaded) {
        return window.buddyLoader({ size: 88 });
      }
      if (this._recentPlays.length === 0) {
        return `<div class="profile-empty">${escape(this._profile.display_name)} hasn't logged any plays yet.</div>`;
      }
      return `<ul class="recent-plays">${this._recentPlays.map((p) => {
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
        return `
          <li onclick="window.PlayDetailPopup.show('${p.id}')">
            ${p.game_thumbnail ? `<img src="${escapeAttr(p.game_thumbnail)}" alt="" />` : `<div class="recent-plays__placeholder"><i data-lucide="dice-6"></i></div>`}
            <div class="recent-plays__body">
              <div class="recent-plays__top">
                <div class="recent-plays__game">${escape(p.game_name)}</div>
                <div class="recent-plays__date">${formatDate(p.played_at)}</div>
              </div>
              ${subParts.length ? `<div class="recent-plays__sub">${subParts.join(" · ")}</div>` : ""}
            </div>
          </li>
        `;
      }).join("")}</ul>`;
    }

    _renderRecentPlaysLoadMore() {
      const hasMore = this._recentPlays.length < this._recentPlaysTotal;
      if (!hasMore) return "";
      return `
        <div class="text-center mt-2">
          <button class="btn btn-ghost btn-xs" ${this._recentPlaysLoading ? "disabled" : ""}
                  onclick="window.profileOtherView._loadMoreRecentPlays()">
            ${this._recentPlaysLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      `;
    }

    _loadMoreRecentPlays() {
      this._recentPlaysPage += 1;
      this._loadRecentPlays();
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

  window.ProfileOtherView = ProfileOtherView;
})();
