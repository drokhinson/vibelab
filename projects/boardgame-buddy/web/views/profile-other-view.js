// views/profile-other-view.js — Public profile hub for another user.
//
// Identity row → four static stat tiles → warm-cream preview cards. The
// settings gear slot is replaced by a buddy-relation button (Buddy up /
// Accept / Request sent / Buddies). "See all →" deep-links into the shared
// collection / plays views, parameterized by ?userId=<them>. Seeded from one
// /profile/bundle round trip so first paint is instant.
//
// The four tiles used to mirror the hub's. The hub has since collapsed its
// own into one tappable .statsblock opening /profile/stats, which is
// self-only — those numbers are about you, not a stranger — so this screen
// is now the sole owner of the .profile-stat-card family rather than a copy
// of it.
//
// TWO AUDIENCES. What this screen draws depends on whether the viewer is
// actually a buddy of the person they are looking at:
//
//   stranger  identity + the four stats + Collection. That is the whole
//             public profile: what they own, and four headline numbers.
//   buddy     the above, plus Head to head (the pair's shared record, drawn
//             as the same split bar the Stats spoke's Nemesis card uses),
//             Top games (their three most-played), and Recent plays.
//
// The gate is `this._profile.is_buddy` from /users/{id}/profile, which is
// fetched fresh on every mount — NOT the bundle, which is cached for up to
// five minutes and could hand back a pre-buddy copy. The RPC enforces the
// same rule server-side (migration 064 nulls recent_plays / together /
// top_games for a stranger), so the client gate is presentation rather than
// the enforcement — GET /plays?user_id= is 403 for a stranger too.

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
          <div class="alert alert-error text-sm mt-3">${escapeHtml(this._error)}</div>
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
        ${this._renderTogether(b)}
        ${this._renderTopGames(b)}
        ${this._renderCollectionPreview(b)}
        ${this._renderPlaysPreview(b)}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();
    }

    /** True once the viewer and this profile are accepted buddies. */
    _isBuddy() {
      return !!(this._profile && this._profile.is_buddy);
    }

    _renderBack() {
      return `
        <header>
          <button class="btn btn-ghost btn-sm" onclick="window.router.back('feed')" aria-label="Back">
            <i data-icon="arrow-left" class="w-4 h-4"></i>
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
            <div class="profile-hub__name font-display">${escapeHtml(p.display_name || "")}</div>
            ${p.username ? `<div class="profile-hub__handle">@${escapeHtml(p.username)}</div>` : ""}
          </div>
          ${this._renderRelationButton(p)}
        </header>
      `;
    }

    _renderRelationButton(p) {
      if (p.is_buddy) {
        return `<button class="btn btn-sm btn-ghost" disabled><i data-icon="check" class="w-4 h-4"></i> Buddies</button>`;
      }
      if (p.has_pending_request) {
        if (p.pending_request_direction === "incoming") {
          return `<button class="btn btn-sm btn-primary" onclick="window.profileOtherView._accept('${p.pending_request_id || ""}')"><i data-icon="user-check" class="w-4 h-4"></i> Accept request</button>`;
        }
        // While the send is still in the air we have no edge id to cancel, so
        // the button states the fact and waits; the echo arms it a beat later.
        return p.pending_request_id
          ? `<button class="btn btn-sm btn-ghost" title="Withdraw your buddy request" onclick="window.profileOtherView._cancel('${p.pending_request_id}')"><i data-icon="x" class="w-4 h-4"></i> Cancel request</button>`
          : `<button class="btn btn-sm btn-ghost" disabled><i data-icon="clock" class="w-4 h-4"></i> Request sent</button>`;
      }
      return `<button class="btn btn-sm btn-primary" onclick="window.profileOtherView._addBuddy('${p.id}')"><i data-icon="user-plus" class="w-4 h-4"></i> Buddy up</button>`;
    }

    // ── Relation mutations ────────────────────────────────────────────────────
    //
    // All three paint first and reconcile behind (.claude/rules/web-frontend.md,
    // "Mutations feel instantaneous"). They used to await the write and then
    // re-run _load(), which drops the profile AND the bundle back to null — so
    // tapping "Buddy up" threw the whole screen back to its loader for a round
    // trip. The button is the only thing that changes, so only it needs to.

    // Snapshot just the four relation fields, so a background bundle refresh
    // landing mid-write can't be erased by a whole-object rollback.
    _relationSnapshot() {
      const p = this._profile || {};
      return {
        is_buddy: p.is_buddy,
        has_pending_request: p.has_pending_request,
        pending_request_direction: p.pending_request_direction,
        pending_request_id: p.pending_request_id,
      };
    }

    async _addBuddy(userId) {
      const p = this._profile;
      if (!p) return;
      const before = this._relationSnapshot();
      Object.assign(p, {
        has_pending_request: true,
        pending_request_direction: "outgoing",
        pending_request_id: null,
      });
      this.render();
      try {
        const res = await window.Buddy.sendRequest(userId);
        // The played-with rows cached in the buddy bundle carry this relation
        // — drop it so the Buddies screen doesn't serve the pre-request copy.
        if (window.Buddy.invalidate) window.Buddy.invalidate();
        if (res && res.direction === "incoming") {
          // Auto-accepted: they had already requested us, so this made us
          // buddies rather than leaving a request pending.
          Object.assign(p, {
            is_buddy: true,
            has_pending_request: false,
            pending_request_direction: null,
            pending_request_id: null,
          });
          this._refreshBundle();
        } else {
          p.pending_request_id = (res && res.id) || null;
        }
      } catch (e) {
        Object.assign(p, before);
        if (typeof showToast === "function") {
          showToast(e.message || "Couldn't send that request", "error");
        }
      }
      this.render();
    }

    async _accept(requestId) {
      const p = this._profile;
      if (!p) return;
      const before = this._relationSnapshot();
      Object.assign(p, {
        is_buddy: true,
        has_pending_request: false,
        pending_request_direction: null,
        pending_request_id: null,
      });
      this.render();
      try {
        // A profile fetched before the API carried pending_request_id still
        // needs the list lookup to find the edge.
        let id = requestId;
        if (!id) {
          const requests = await window.Buddy.requests();
          const inc = (requests.incoming || []).find((r) => r.other_user_id === p.id);
          id = inc && inc.id;
        }
        if (!id) throw new Error("That request is no longer pending");
        await window.Buddy.accept(id);
        if (window.Buddy.invalidate) window.Buddy.invalidate();
        // One request off the pile the Profile tab's dot is counting. This
        // screen holds no request list to re-measure, so it steps the store
        // slot instead. After the await on purpose: a failed accept leaves the
        // count untouched rather than needing a rollback of its own.
        window.Buddy.setPendingCount(window.Buddy.pendingCount() - 1);
        this._refreshBundle();
      } catch (e) {
        Object.assign(p, before);
        this.render();
        if (typeof showToast === "function") {
          showToast(e.message || "Couldn't accept that request", "error");
        }
      }
    }

    // Withdraw a request we sent. One tap re-sends it, so no confirm gate —
    // those are reserved for the destructive actions (unfriend).
    async _cancel(requestId) {
      const p = this._profile;
      if (!p || !requestId) return;
      const before = this._relationSnapshot();
      Object.assign(p, {
        has_pending_request: false,
        pending_request_direction: null,
        pending_request_id: null,
      });
      this.render();
      try {
        await window.Buddy.cancel(requestId);
        if (window.Buddy.invalidate) window.Buddy.invalidate();
      } catch (e) {
        Object.assign(p, before);
        this.render();
        if (typeof showToast === "function") {
          showToast(e.message || "Couldn't cancel that request", "error");
        }
      }
    }

    // Becoming buddies unlocks three blocks the cached bundle was never given
    // (head to head, top games, recent plays), so pull a fresh one. Force,
    // because the cached copy is still inside its fresh window and SWR would
    // hand back the stranger's payload without going to the network. Fire and
    // forget: the relation button has already flipped, and a failure here just
    // leaves the new blocks to the next mount.
    _refreshBundle() {
      const userId = this._userId();
      if (!userId) return;
      window.Profile
        .bundle(userId, { force: true, colPerPage: PREVIEW_COVERS, playsPerPage: PREVIEW_PLAYS })
        .then((b) => {
          // Guard against landing after the user has navigated to someone else.
          if (this._userId() !== userId) return;
          this._bundle = b;
          this._seedViewerMaps(b);
          this.render();
        })
        .catch((e) => {
          if (window.console) console.warn("profile bundle refresh failed", e);
        });
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
            <div class="profile-stat-card__v profile-stat-card__v--text" title="${escapeAttr(favName)}">${escapeHtml(favName)}</div>
            <div class="profile-stat-card__k">Top game</div>
          </button>
        </section>
      `;
    }

    // ── Buddy-only: head to head ──────────────────────────────────────────────
    //
    // Deliberately the Nemesis card from the Stats spoke, re-pointed at a pair
    // the viewer chose instead of the one the RPC ranked — same split bar, same
    // legend, same three segments. Where Nemesis leads with the other person's
    // avatar (it is introducing someone), this one leads with the count: you
    // already know who you are looking at, so the news is how the record stands.
    //
    // `together` is competitive-only and counts plays you both SAT IN, so a
    // co-op night or a play one of you merely logged is out — see migration 064.
    _renderTogether(b) {
      const t = b && b.together;
      // Null for a stranger, and for a buddy the two have never actually sat
      // down against each other — a brand-new buddy has no record to show.
      if (!this._isBuddy() || !t) return "";
      const shared = t.shared_plays || 0;
      const yours = t.your_wins || 0;
      const theirs = t.their_wins || 0;
      const other = Math.max(0, shared - yours - theirs);
      // A play the table called a tie has two winners, so the three segments can
      // sum past `shared` — divide by whichever is larger or the bar overflows.
      const total = Math.max(shared, yours + theirs + other) || 1;
      const pctOf = (v) => (v / total) * 100;
      const them = this._firstName(this._profile.display_name);
      return `
        <section class="preview-card">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="handshake" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Head to head</h3>
            <span class="preview-card__sub">${shared} shared ${shared === 1 ? "play" : "plays"}</span>
          </header>
          <div class="profile-h2h">
            <div class="profile-h2h__v">${yours}<span class="profile-h2h__sep">/</span>${theirs}</div>
            <div class="profile-h2h__s">
              You've won ${yours} of the ${shared} ${shared === 1 ? "game" : "games"}
              you and ${escapeHtml(them)} have both sat down for.
            </div>
          </div>
          <div class="stats-split">
            <i class="stats-split__win" style="width:${pctOf(yours).toFixed(1)}%"></i>
            <i class="stats-split__them" style="width:${pctOf(theirs).toFixed(1)}%"></i>
            <i class="stats-split__loss" style="width:${pctOf(other).toFixed(1)}%"></i>
          </div>
          <div class="stats-legend">
            <span>You <b>${yours}</b></span>
            <span>${escapeHtml(them)} <b>${theirs}</b></span>
            ${other ? `<span>Someone else <b>${other}</b></span>` : ""}
          </div>
        </section>
      `;
    }

    // ── Buddy-only: their top three ───────────────────────────────────────────
    _renderTopGames(b) {
      const games = (b && b.top_games) || [];
      if (!this._isBuddy() || !games.length) return "";
      return `
        <section class="preview-card">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="trophy" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Top games</h3>
            <span class="preview-card__sub">Most played</span>
          </header>
          <div class="preview-card__body">
            <div class="profile-topgames">${games.slice(0, 3).map((g) => this._topGame(g)).join("")}</div>
          </div>
        </section>
      `;
    }

    _topGame(g) {
      const plays = g.play_count || 0;
      // gameArtImg() wants the Game shape the collection rows carry; top_games
      // is a flat row, so hand it the two art fields under the names it reads.
      const art = gameArtImg(
        { name: g.name, thumbnail_url: g.thumbnail_url, image_url: g.image_url },
        "card",
        { alt: g.name || "" },
      );
      return `
        <button class="profile-topgames__item"
                onclick="window.router.go('game-detail',{gameId:'${g.game_id}',gameName:'${jsStr(g.name || "")}'})">
          <span class="profile-topgames__art">
            ${art || `<span class="preview-card__cover-fallback">${escapeHtml((g.name || "?").slice(0, 14))}</span>`}
          </span>
          <span class="profile-topgames__n" title="${escapeAttr(g.name || "")}">${escapeHtml(g.name || "")}</span>
          <span class="profile-topgames__c">${plays} ${plays === 1 ? "play" : "plays"}</span>
        </button>
      `;
    }

    // ── Preview cards ─────────────────────────────────────────────────────────
    _renderCollectionPreview(b) {
      const items = (b && b.owned_page) || [];
      const count = (b && b.owned_total) || 0;
      // Games only — matches the self hub (profile-self-view.js).
      const subtitle = `${count} game${count === 1 ? "" : "s"}`;
      return this._previewCard({
        icon: "library-big",
        title: "Collection",
        sub: subtitle,
        seeAllJs: "window.profileOtherView._goCollection()",
        body: items.length
          ? `<div class="preview-card__covers">${items.slice(0, PREVIEW_COVERS).map((it) => this._cover(it)).join("")}</div>`
          : `<div class="preview-card__empty">${escapeHtml(this._profile.display_name || "They")} doesn't own any games yet.</div>`,
      });
    }

    // Buddies only. `recent_plays` is null rather than [] for a stranger, and
    // the empty state below would otherwise announce "hasn't logged any plays
    // yet" about someone who has logged plenty.
    _renderPlaysPreview(b) {
      if (!this._isBuddy()) return "";
      const plays = (b && b.recent_plays) || [];
      const total = (b && b.recent_plays_total) || 0;
      const body = plays.length
        ? `<ul class="preview-card__plays">${plays.slice(0, PREVIEW_PLAYS).map((p) => this._playRow(p)).join("")}</ul>`
        : `<div class="preview-card__empty">${escapeHtml(this._profile.display_name || "They")} hasn't logged any plays yet.</div>`;
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
            <span class="preview-card__icon"><i data-icon="${icon}" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">${escapeHtml(title)}</h3>
            <span class="preview-card__sub">${escapeHtml(sub)}</span>
            <button class="preview-card__seeall" onclick="${seeAllJs}">
              See all <i data-icon="chevron-right" class="w-3 h-3"></i>
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
          ${gameArtImg(g, "card", { alt: g.name || "" })
            || `<div class="preview-card__cover-fallback">${escapeHtml((g.name || "?").slice(0, 14))}</div>`}
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
            : `<div class="preview-card__play-thumb preview-card__play-thumb--placeholder"><i data-icon="dice-6" class="w-4 h-4"></i></div>`}
          <div class="preview-card__play-info">
            <div class="preview-card__play-name">${escapeHtml(p.game_name || "")}</div>
            ${playerCount > 0 ? `<div class="preview-card__play-meta">${playerCount} ${playerCount === 1 ? "player" : "players"}</div>` : ""}
          </div>
          <div class="preview-card__play-date">${formatDateShort(p.played_at)}</div>
        </li>
      `;
    }

    // "Ada Lovelace" → "Ada", for the legend and the sentence above it.
    _firstName(name) {
      return String(name || "They").trim().split(/\s+/)[0] || "They";
    }
  }

  function formatDateShort(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  window.ProfileOtherView = ProfileOtherView;
})();
