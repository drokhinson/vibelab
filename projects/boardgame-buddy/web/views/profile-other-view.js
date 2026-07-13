// views/profile-other-view.js — Public profile hub for another user.
//
// Mirrors profile-self-view's layout (identity row → four stat tiles →
// warm-cream preview cards) but trimmed to Collection and Recent plays
// only — no Wishlist, no Buddies sections. The settings gear slot is
// replaced by a buddy-relation button (Buddy up / Accept / Request sent
// / Buddies). "See all →" deep-links into the shared collection / plays
// views, parameterized by ?userId=<them>. Seeded from one /profile/bundle
// round trip so first paint is instant.

(function () {
  const PREVIEW_COVERS = 4;
  const PREVIEW_PLAYS = 2;

  class ProfileOtherView extends window.View {
    constructor() {
      super("profile-other");
      this._profile = null;
      this._bundle = null;
      this._error = null;
    }

    async onMount() {
      await this._load();
    }
    async onParamsChange() { await this._load(); }

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
      this._profile = null;
      this._bundle = null;
      this._error = null;
      this.render();
      const profilePromise = window.User.fetch(userId)
        .then((p) => { this._profile = p; this.render(); })
        .catch((e) => { this._error = e.message || "Failed to load profile"; this.render(); });
      const bundlePromise = window.Profile
        .bundle(userId, { colPerPage: PREVIEW_COVERS, playsPerPage: PREVIEW_PLAYS })
        .then((b) => { this._bundle = b; this._seedViewerMaps(b); this.render(); })
        .catch((e) => {
          if (window.console) console.warn("profile bundle failed", e);
        });
      await Promise.all([profilePromise, bundlePromise]);
    }

    _seedViewerMaps(b) {
      // Prime the viewer's own collection maps so the collection spoke
      // paints "you own this" pills instantly when "See all →" is tapped.
      if (b && b.status_map && b.expansion_counts && window.Collection && window.Collection.seedFromBundle) {
        window.Collection.seedFromBundle(b.status_map, b.expansion_counts);
      }
    }

    renderLoading() { this.render(); }

    render() {
      if (this._error) {
        this.container.innerHTML = `
          ${this._renderBack()}
          <div class="alert alert-error text-sm mt-3">${escape(this._error)}</div>
        `;
        this.refreshIcons();
        return;
      }
      if (!this._profile || !this._bundle) {
        this.container.innerHTML = `
          ${this._renderBack()}
          <div class="profile-loading">${window.buddyLoader({ size: 96, label: "Loading profile…" })}</div>
        `;
        this.refreshIcons();
        return;
      }
      const b = this._bundle;
      this.container.innerHTML = `
        ${this._renderBack()}
        ${this._renderIdRow(this._profile)}
        ${this._renderStats(b)}
        ${this._renderCollectionPreview(b)}
        ${this._renderPlaysPreview(b)}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();
    }

    _renderBack() {
      return `
        <header>
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')" aria-label="Back">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
        </header>
      `;
    }

    // ── Identity row ──────────────────────────────────────────────────────────
    _renderIdRow(p) {
      const badge = window.BgbBadge.render({
        avatar: p.avatar,
        displayName: p.display_name,
        size: "lg",
        extraClass: "profile-hub__avatar",
      });
      return `
        <header class="profile-hub__id">
          ${badge}
          <div class="profile-hub__who">
            <div class="profile-hub__name font-display">${escape(p.display_name || "")}</div>
            ${p.username ? `<div class="profile-hub__handle">@${escape(p.username)}</div>` : ""}
          </div>
          ${this._renderRelationButton(p)}
        </header>
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

    // ── Four stat tiles ───────────────────────────────────────────────────────
    _renderStats(b) {
      const stats = (b && b.stats) || {};
      const owned = stats.owned_games || 0;
      const plays = (b && b.recent_plays_total) || stats.total_plays || 0;
      const wins = stats.win_count || 0;
      const fav = stats.favorite_game || null;
      const favName = fav ? fav.name : "—";
      const favClick = fav
        ? `onclick="window.router.go('game-detail',{gameId:'${fav.game_id}',gameName:'${jsStr(fav.name || "")}'})"`
        : "";
      return `
        <section class="profile-hub__stats">
          <div class="profile-stat-card profile-stat-card--static">
            <div class="profile-stat-card__v">${owned}</div>
            <div class="profile-stat-card__k">Games</div>
          </div>
          <div class="profile-stat-card profile-stat-card--static">
            <div class="profile-stat-card__v">${plays}</div>
            <div class="profile-stat-card__k">Plays</div>
          </div>
          <div class="profile-stat-card profile-stat-card--static">
            <div class="profile-stat-card__v">${wins}</div>
            <div class="profile-stat-card__k">Wins</div>
          </div>
          <button class="profile-stat-card profile-stat-card--fav" ${favClick}>
            <div class="profile-stat-card__v profile-stat-card__v--text" title="${escapeAttr(favName)}">${escape(favName)}</div>
            <div class="profile-stat-card__k">Top game</div>
          </button>
        </section>
      `;
    }

    // ── Preview cards ─────────────────────────────────────────────────────────
    _renderCollectionPreview(b) {
      const items = (b && b.owned_page) || [];
      const count = (b && b.owned_total) || 0;
      const ownedExp = (b && b.stats && b.stats.owned_expansions) || 0;
      const subtitle = ownedExp > 0
        ? `${count} games · ${ownedExp} expansion${ownedExp === 1 ? "" : "s"}`
        : `${count} game${count === 1 ? "" : "s"}`;
      return this._previewCard({
        icon: "library-big",
        title: "Collection",
        sub: subtitle,
        seeAllJs: "window.profileOtherView._goCollection()",
        body: items.length
          ? `<div class="preview-card__covers">${items.slice(0, PREVIEW_COVERS).map((it) => this._cover(it)).join("")}</div>`
          : `<div class="preview-card__empty">${escape(this._profile.display_name || "They")} doesn't own any games yet.</div>`,
      });
    }

    _renderPlaysPreview(b) {
      const plays = (b && b.recent_plays) || [];
      const total = (b && b.recent_plays_total) || 0;
      const body = plays.length
        ? `<ul class="preview-card__plays">${plays.slice(0, PREVIEW_PLAYS).map((p) => this._playRow(p)).join("")}</ul>`
        : `<div class="preview-card__empty">${escape(this._profile.display_name || "They")} hasn't logged any plays yet.</div>`;
      return this._previewCard({
        icon: "dices",
        title: "Recent plays",
        sub: `${total} total`,
        seeAllJs: "window.profileOtherView._goPlays()",
        body,
      });
    }

    _goCollection() { window.router.go("collection", { userId: this._userId() }); }
    _goPlays() { window.router.go("plays", { userId: this._userId() }); }

    _previewCard({ icon, title, sub, seeAllJs, body }) {
      return `
        <section class="preview-card">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-lucide="${icon}" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">${escape(title)}</h3>
            <span class="preview-card__sub">${escape(sub)}</span>
            <button class="preview-card__seeall" onclick="${seeAllJs}">
              See all <i data-lucide="chevron-right" class="w-3 h-3"></i>
            </button>
          </header>
          <div class="preview-card__body">${body}</div>
        </section>
      `;
    }

    _cover(item) {
      const g = item.game || {};
      const click = `onclick="window.router.go('game-detail',{gameId:'${g.id}',gameName:'${jsStr(g.name || "")}'})"`;
      return `
        <div class="preview-card__cover" ${click} title="${escapeAttr(g.name || "")}">
          ${g.thumbnail_url
            ? `<img src="${escapeAttr(g.thumbnail_url)}" alt="${escapeAttr(g.name || "")}" loading="lazy" />`
            : `<div class="preview-card__cover-fallback">${escape((g.name || "?").slice(0, 14))}</div>`}
        </div>
      `;
    }

    _playRow(p) {
      const playerCount = (p.players || []).length;
      const gameNav = `event.stopPropagation();window.router.go('game-detail',{gameId:'${p.game_id}',gameName:'${jsStr(p.game_name || "")}'})`;
      return `
        <li class="preview-card__play" onclick="window.PlayDetailPopup.show('${p.id}')">
          ${p.game_thumbnail
            ? `<img class="preview-card__play-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" onclick="${gameNav}" />`
            : `<div class="preview-card__play-thumb preview-card__play-thumb--placeholder"><i data-lucide="dice-6" class="w-4 h-4"></i></div>`}
          <div class="preview-card__play-info">
            <div class="preview-card__play-name">${escape(p.game_name || "")}</div>
            ${playerCount > 0 ? `<div class="preview-card__play-meta">${playerCount} ${playerCount === 1 ? "player" : "players"}</div>` : ""}
          </div>
          <div class="preview-card__play-date">${formatDateShort(p.played_at)}</div>
        </li>
      `;
    }
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }
  function formatDateShort(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  window.ProfileOtherView = ProfileOtherView;
})();
