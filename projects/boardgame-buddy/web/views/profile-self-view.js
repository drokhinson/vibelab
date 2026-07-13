// views/profile-self-view.js — Profile Hub.
//
// Identity row → four tappable stat tiles → warm-cream preview cards
// (Collection / Wishlist / Recent plays / Buddies). Each preview's
// "See all →" routes to a dedicated full-screen spoke. Settings is
// reachable via the avatar in the global header. All cards seed from
// a single /profile/bundle call.

(function () {
  const PREVIEW_COVERS = 4;
  const PREVIEW_PLAYS = 2;
  const PREVIEW_BUDDIES = 5;

  class ProfileSelfView extends window.View {
    constructor() {
      super("profile-self");
      this._bundle = null;
      this._loading = true;
      this._error = null;
    }

    async onMount() {
      this.listen("user", () => this.render());
      this._loading = true;
      this.render();
      try {
        const me = window.store.get("user");
        const bundle = await window.Profile.bundle(me.id);
        this._bundle = bundle;
        // Stash for the spokes so hub → spoke paints from cache before
        // the background refresh lands. Each spoke also calls
        // Profile.bundle() which is cache-backed in bgbCache.
        window.store.set("profileBundle", bundle);
      } catch (e) {
        this._error = e.message || "Failed to load profile";
      } finally {
        this._loading = false;
        this.render();
      }
    }

    renderLoading() { this.render(); }

    render() {
      const me = window.store.get("user");
      if (!me) {
        this.container.innerHTML = `<div class="p-6 text-center">Not signed in.</div>`;
        return;
      }
      const b = this._bundle;
      if (!b && !this._error) {
        this.container.innerHTML = `
          <div class="profile-loading">${window.buddyLoader({ size: 96, label: "Loading profile…" })}</div>
        `;
        this.refreshIcons();
        return;
      }
      this.container.innerHTML = `
        ${this._renderIdRow(me)}
        ${this._renderStats(b)}
        ${this._error ? `<div class="alert alert-error text-sm mt-3">${escape(this._error)}</div>` : ""}
        ${this._renderCollectionPreview(b)}
        ${this._renderWishlistPreview(b)}
        ${this._renderPlaysPreview(b)}
        ${this._renderBuddiesPreview(b)}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();
    }

    // ── Identity row ──────────────────────────────────────────────────────────
    _renderIdRow(me) {
      const badge = window.BgbBadge.render({
        avatar: me.avatar,
        displayName: me.display_name,
        size: "lg",
        isMe: true,
        extraClass: "profile-hub__avatar",
      });
      return `
        <header class="profile-hub__id">
          ${badge}
          <div class="profile-hub__who">
            <div class="profile-hub__name font-display">${escape(me.display_name || "")}</div>
            ${me.username ? `<div class="profile-hub__handle">@${escape(me.username)}</div>` : ""}
          </div>
        </header>
      `;
    }

    // ── Four stat tiles ───────────────────────────────────────────────────────
    _renderStats(b) {
      const stats = (b && b.stats) || {};
      const owned = stats.owned_games || 0;
      const plays = (b && b.recent_plays_total) || stats.total_plays || 0;
      const buds = (b && b.buddies && b.buddies.length) || 0;
      const fav = stats.favorite_game || null;
      const favName = fav ? fav.name : "—";
      const favClick = fav
        ? `onclick="window.router.go('game-detail',{gameId:'${fav.game_id}',gameName:'${jsStr(fav.name || "")}'})"`
        : "";
      return `
        <section class="profile-hub__stats">
          <button class="profile-stat-card" onclick="window.router.go('collection')">
            <div class="profile-stat-card__v">${owned}</div>
            <div class="profile-stat-card__k">Games</div>
          </button>
          <button class="profile-stat-card" onclick="window.router.go('plays')">
            <div class="profile-stat-card__v">${plays}</div>
            <div class="profile-stat-card__k">Plays</div>
          </button>
          <button class="profile-stat-card" onclick="window.router.go('buddies')">
            <div class="profile-stat-card__v">${buds}</div>
            <div class="profile-stat-card__k">Buddies</div>
          </button>
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
        route: "collection",
        body: items.length
          ? `<div class="preview-card__covers">${items.slice(0, PREVIEW_COVERS).map((it) => this._cover(it)).join("")}</div>`
          : `<div class="preview-card__empty">No owned games yet — tap See all to add one.</div>`,
      });
    }

    _renderWishlistPreview(b) {
      const items = (b && b.wishlist_page) || [];
      const count = (b && b.wishlist_total) || 0;
      return this._previewCard({
        icon: "star",
        title: "Wishlist",
        sub: `${count} game${count === 1 ? "" : "s"}`,
        route: "wishlist",
        body: items.length
          ? `<div class="preview-card__covers">${items.slice(0, PREVIEW_COVERS).map((it) => this._cover(it)).join("")}</div>`
          : `<div class="preview-card__empty">Nothing on your wishlist yet.</div>`,
        modifier: "preview-card--wishlist",
      });
    }

    _renderPlaysPreview(b) {
      const plays = (b && b.recent_plays) || [];
      const total = (b && b.recent_plays_total) || 0;
      const body = plays.length
        ? `<ul class="preview-card__plays">${plays.slice(0, PREVIEW_PLAYS).map((p) => this._playRow(p)).join("")}</ul>`
        : `<div class="preview-card__empty">No plays logged yet.</div>`;
      return this._previewCard({
        icon: "dices",
        title: "Recent plays",
        sub: `${total} total`,
        route: "plays",
        body,
      });
    }

    _renderBuddiesPreview(b) {
      const buddies = (b && b.buddies) || [];
      const count = buddies.length;
      let body;
      if (!count) {
        body = `<div class="preview-card__empty">No buddies yet — tap See all to invite some.</div>`;
      } else {
        const shown = buddies.slice(0, PREVIEW_BUDDIES);
        const extra = Math.max(0, count - shown.length);
        body = `
          <div class="preview-card__buds">
            ${shown.map((bud) => window.BgbBadge.render({
              avatar: bud.other_avatar,
              displayName: bud.other_display_name,
              size: "sm",
              extraClass: "preview-card__bud",
            })).join("")}
            ${extra > 0 ? `<div class="preview-card__bud preview-card__bud--more">+${extra}</div>` : ""}
          </div>
        `;
      }
      return this._previewCard({
        icon: "users",
        title: "Buddies",
        sub: `${count} ${count === 1 ? "player" : "players"}`,
        route: "buddies",
        body,
      });
    }

    _previewCard({ icon, title, sub, route, body, modifier = "" }) {
      return `
        <section class="preview-card ${modifier}">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-lucide="${icon}" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">${escape(title)}</h3>
            <span class="preview-card__sub">${escape(sub)}</span>
            <button class="preview-card__seeall" onclick="window.router.go('${route}')">
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
      const me = window.store.get("user");
      const winners = (p.players || []).filter((pl) => pl.is_winner);
      // "You won" tag — match on user_id first, fall back to display_name
      // (older plays may not carry user_id on every player row).
      const youWon = winners.some((w) =>
        (w.user_id && me && w.user_id === me.id) ||
        (me && (w.name || "") === (me.display_name || ""))
      );
      const playerCount = (p.players || []).length;
      const gameNav = `event.stopPropagation();window.router.go('game-detail',{gameId:'${p.game_id}',gameName:'${jsStr(p.game_name || "")}'})`;
      return `
        <li class="preview-card__play" onclick="window.PlayDetailPopup.show('${p.id}')">
          ${p.game_thumbnail
            ? `<img class="preview-card__play-thumb" src="${escapeAttr(p.game_thumbnail)}" alt="" onclick="${gameNav}" />`
            : `<div class="preview-card__play-thumb preview-card__play-thumb--placeholder"><i data-lucide="dice-6" class="w-4 h-4"></i></div>`}
          <div class="preview-card__play-info">
            <div class="preview-card__play-name">
              ${escape(p.game_name || "")}
              ${youWon ? `<span class="preview-card__play-won"><i data-lucide="trophy" class="w-3 h-3"></i> Won</span>` : ""}
            </div>
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
  function initialsOf(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }
  function formatDateShort(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  window.ProfileSelfView = ProfileSelfView;
})();
