// views/profile-self-view.js — Profile Hub.
//
// Account card → a tappable "Your stats" block → warm-cream preview cards
// (Collection / Achievements / Recent plays / Buddies). Each
// preview's "See all →" routes to a dedicated full-screen spoke, and the stats
// block routes to /profile/stats. Settings is reachable via the avatar in the
// global header. Every card but Achievements seeds from a single
// /profile/bundle call; Achievements paints from its own cached payload and
// refreshes in the background, so first paint still costs exactly one call.
//
// The account card (identity + "Edit profile") used to live in Settings.
// It sits here instead so the hub's own identity block is the thing you
// edit, rather than a read-only echo of a card one screen away.

(function () {
  const PREVIEW_COVERS = 4;
  const PREVIEW_PLAYS = 2;
  const PREVIEW_BUDDIES = 5;
  const PREVIEW_BADGES = 4;
  // The Achievements card repaints in place rather than through render(), so
  // the background fetch that fills it can't blow away a scroll position or a
  // half-open sheet elsewhere on the hub.
  const ACH_HOST_ID = "profile-ach-card";

  class ProfileSelfView extends window.View {
    constructor() {
      super("profile-self");
      this._bundle = null;
      this._loading = true;
      this._error = null;
      // Achievements are NOT part of /profile/bundle: the hub's one-call
      // promise stays intact because this card paints from the cached payload
      // (bgbCache, write-through to localStorage) and only then refreshes in
      // the background.
      this._ach = null;
    }

    async onMount() {
      this.listen("user", () => this.render());
      // Every hub card's corner badge reads its store slot, not the bundle the
      // card was painted from — so answering a buddy request, a link request
      // or an "is this you?" on the Buddies spoke, or marking badges seen on
      // the Achievements spoke, finds the corner already clear on the way
      // back. Which slots exist is domain/notifications.js's table; this view
      // just listens to all of them rather than naming four by hand and
      // forgetting the fifth.
      for (const slot of window.BgbNotifications.slots()) {
        this.listen(slot, () => this.render());
      }
      this._loading = true;
      this._ach = window.Achievements.cached();
      this.render();
      // Fire alongside the bundle, not after it — the card is already on
      // screen from cache, so this only ever upgrades what is painted.
      window.Achievements.all()
        .then((payload) => {
          if (!payload) return;
          this._ach = payload;
          this._paintAchievements();
        })
        .catch(() => { /* the card falls back to its cached copy, or hides */ });
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
        ${this._renderAccountCard(me)}
        ${this._renderStats(b)}
        ${this._error ? `<div class="alert alert-error text-sm mt-3">${escapeHtml(this._error)}</div>` : ""}
        ${this._renderCollectionPreview(b)}
        ${this._renderAchievementsPreview()}
        ${this._renderPlaysPreview(b)}
        ${this._renderBuddiesPreview(b)}
        <div style="height: 1rem"></div>
      `;
      this.refreshIcons();
    }

    // ── Account card ──────────────────────────────────────────────────────────
    // Same .set-card markup Settings used to render — the hub is not a
    // .bgb-spoke-screen, but .set-card reads the --polaroid-* tokens directly,
    // which is what .statsblock and .preview-card below already use.
    _renderAccountCard(me) {
      const badge = window.BgbBadge.render({
        avatar: me.avatar,
        displayName: me.display_name,
        size: "md",
        isMe: true,
        extraClass: "set-card__acct-avatar",
      });
      return `
        <div class="set-card">
          <div class="set-card__acct">
            ${badge}
            <div class="set-card__acct-body">
              <div class="set-card__acct-name">${escapeHtml(me.display_name || "")}</div>
              ${me.username ? `
                <div class="set-card__acct-handle" title="Your username never changes. Buddies can find you with it.">
                  <i data-icon="at-sign" class="w-3.5 h-3.5"></i>
                  ${escapeHtml(me.username)}
                </div>` : ""}
            </div>
            <div class="set-card__acct-actions">
              <button class="set-card__acct-btn" type="button"
                      title="Add a buddy by QR code" aria-label="Add a buddy by QR code"
                      onclick="window.profileSelfView._openQr(this)">
                <i data-icon="qr-code" class="w-5 h-5"></i>
              </button>
              <button class="set-card__acct-btn" type="button"
                      title="Edit your profile" aria-label="Edit your profile"
                      onclick="window.profileSelfView._openEditProfile()">
                <i data-icon="pencil" class="w-5 h-5"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // The same add-a-buddy sheet the Buddies screen opens — show your code, or
    // scan theirs. It sits here because this card is the app's answer to "how
    // do people find me", and the QR is the fastest one.
    _openQr(btn) {
      if (!window.BuddyQrSheet) return;
      window.BuddyQrSheet.open({
        returnFocus: btn || null,
        onAdded: () => this._afterQrAdd(),
        // Same unconditional hook the Buddies screen passes: it no-ops when no
        // first-run hold is active, and one code path beats two.
        onClose: () => { if (window.bgbQrFlowEnded) window.bgbQrFlowEnded(); },
      });
    }

    /** The hub's Buddies preview is drawn from the profile bundle, so a QR add
     *  behind the sheet leaves it a person short until something drops it. */
    async _afterQrAdd() {
      window.Buddy.invalidate();
      if (window.Profile.invalidate) {
        const me = window.store.get("user");
        if (me) window.Profile.invalidate(me.id);
      }
      await this.onMount();
    }

    async _openEditProfile() {
      const me = window.store.get("user");
      if (!me) return;
      const picked = await window.PolaroidPopup.avatarCustomizer({
        headerTitle: "Edit your profile",
        includeNameField: true,
        saveLabel: "Save",
        current: me.avatar || null,
        displayName: me.display_name,
      });
      if (!picked) return;
      try {
        const body = {
          avatar: { icon: picked.icon, iconColor: picked.iconColor, bgColor: picked.bgColor },
        };
        if (picked.displayName && picked.displayName !== me.display_name) {
          body.display_name = picked.displayName;
        }
        const updated = await window.api.post("/profile", body);
        // Carry the new fields onto the in-memory user so the rest of the
        // app re-renders against them. Store.set() fires listeners → render().
        const next = new window.User({ ...me, ...updated });
        window.store.set("user", next);
      } catch (e) {
        window.PolaroidPopup.alert({
          title: "Couldn't save profile",
          body: e && e.message ? String(e.message) : "Please try again.",
        });
      }
    }

    // ── Stats block ───────────────────────────────────────────────────────────
    // One card, one destination. This used to be four separate tiles routing
    // to four different places (Games→Collection, Plays→Plays, Buddies→
    // Buddies, Top game→Game detail), which put four small tap targets in a
    // row that read as one control. Games and Buddies are not lost: the
    // Collection and Buddies preview cards below already print those totals in
    // their own sub-heads, and every number here is shown in fuller form on the
    // Stats spoke.
    //
    // Plays / Wins / Top game all come off the bundle's stats block, so this
    // block costs nothing of its own — the spoke is what fetches the detail.
    _renderStats(b) {
      const stats = (b && b.stats) || {};
      const plays = (b && b.recent_plays_total) || stats.total_plays || 0;
      const wins = stats.win_count || 0;
      const fav = stats.favorite_game || null;
      const favName = fav ? fav.name : "—";
      const last = stats.last_played_at
        ? `Last played ${formatDateShort(stats.last_played_at)}`
        : "No plays yet";
      return `
        <section class="statsblock" role="button" tabindex="0"
                 aria-label="Your stats — open the stats screen"
                 onclick="window.router.go('stats')"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.router.go('stats')}">
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="trophy" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Your stats</h3>
            <span class="preview-card__sub">${escapeHtml(last)}</span>
            <span class="preview-card__seeall">
              See all <i data-icon="chevron-right" class="w-3 h-3"></i>
            </span>
          </header>
          <div class="statsblock__row">
            <div class="statsblock__cell">
              <div class="statsblock__v">${plays}</div>
              <div class="statsblock__k">Plays</div>
            </div>
            <div class="statsblock__cell">
              <div class="statsblock__v">${wins}</div>
              <div class="statsblock__k">Wins</div>
            </div>
            <div class="statsblock__cell">
              <span class="statsblock__crown"><i data-icon="crown" class="w-3.5 h-3.5"></i></span>
              <div class="statsblock__v statsblock__v--text" title="${escapeAttr(favName)}">${escapeHtml(favName)}</div>
              <div class="statsblock__k">Top game</div>
            </div>
          </div>
        </section>
      `;
    }

    // ── Achievements ──────────────────────────────────────────────────────────
    // Four medallions: everything newly earned first, then whatever is closest
    // to landing — so a brand-new account gets "here is what is within reach"
    // rather than four grey discs.
    _renderAchievementsPreview() {
      const a = this._ach;
      if (!a || !Array.isArray(a.achievements) || !a.achievements.length) {
        // Nothing cached and nothing fetched yet: render the host empty rather
        // than a skeleton. The card slides in when the payload lands.
        return `<div id="${ACH_HOST_ID}"></div>`;
      }
      return `<div id="${ACH_HOST_ID}">${this._achCardInner(a)}</div>`;
    }

    _paintAchievements() {
      const host = this.container && this.container.querySelector(`#${ACH_HOST_ID}`);
      if (!host || !this._ach) return;
      host.innerHTML = this._achCardInner(this._ach);
      this.refreshIcons(host);
    }

    _achCardInner(a) {
      // Counted off the payload this card is about to paint, not off the
      // store slot the nav dot reads: the card should badge exactly what it is
      // showing. Both are computed from the same seen-set on disk.
      //
      // So this deliberately does NOT go through
      // BgbNotifications.forSection("achievements") the way the Buddies card
      // goes through forSection("buddies"). The registry row is still correct
      // — this is where an unseen badge resolves, and it belongs on the tab's
      // dot — but between the cached payload painting and the fresh one
      // landing, the slot and this card can name different numbers, and the
      // one under the user's eyes is the one to trust.
      const unseen = window.Achievements.unseen(a).length;
      const picks = this._badgePicks(a.achievements);
      const body = `
        <div class="preview-card__badges">
          ${picks.map((b) => `
            <span class="preview-card__badge ${b.earned ? "is-earned" : "is-locked"}"
                  title="${escapeAttr(`${b.name} — ${b.earned ? b.tagline : b.requirement}`)}">
              <img src="${escapeAttr(window.Achievements.spriteUrl(b.icon))}" alt=""
                   width="160" height="160" loading="lazy" decoding="async" />
            </span>
          `).join("")}
        </div>
      `;
      return `
        <section class="preview-card">
          ${this._countBadge(unseen, `${unseen} new achievement${unseen === 1 ? "" : "s"}`)}
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="trophy" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">Achievements</h3>
            <span class="preview-card__sub">${a.earned_count} of ${a.total}</span>
            <button class="preview-card__seeall" onclick="window.router.go('achievements')">
              See all
              <i data-icon="chevron-right" class="w-3 h-3"></i>
            </button>
          </header>
          <div class="preview-card__body">${body}</div>
        </section>
      `;
    }

    _badgePicks(all) {
      const earned = all.filter((x) => x.earned)
        .sort((x, y) => new Date(y.unlocked_at || 0) - new Date(x.unlocked_at || 0));
      const locked = all.filter((x) => !x.earned)
        .sort((x, y) => (y.progress / y.threshold) - (x.progress / x.threshold));
      return earned.concat(locked).slice(0, PREVIEW_BADGES);
    }

    // ── Preview cards ─────────────────────────────────────────────────────────
    _renderCollectionPreview(b) {
      const items = (b && b.owned_page) || [];
      const count = (b && b.owned_total) || 0;
      // Games only — owned expansions are surfaced per-tile in the Collection
      // spoke (collection-view.js) rather than folded into this count.
      const subtitle = `${count} game${count === 1 ? "" : "s"}`;
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
      // Things to do rather than things to look at, which is why they get the
      // corner badge while the roster size stays a sub-head. Buddy requests,
      // ghost link requests and "is this you?" suggestions are summed because
      // all three are answered on the one screen this card opens — that is
      // what `section: "buddies"` means in domain/notifications.js. The label
      // names them separately so the badge is never just an unexplained "3".
      const { total: waiting, parts } = window.BgbNotifications.forSection("buddies");
      return this._previewCard({
        icon: "users",
        title: "Buddies",
        sub: `${count} ${count === 1 ? "player" : "players"}`,
        route: "buddies",
        body,
        badge: waiting,
        badgeLabel: `${window.BgbNotifications.phrase(parts)} waiting`,
      });
    }

    /**
     * The corner badge a hub card wears when something behind it is waiting —
     * buddy requests, ghost link requests, unseen achievements. The number is
     * aria-hidden and the phrase beside it carries the meaning, because "3"
     * alone in a card corner tells a screen reader nothing about what there
     * are three of.
     */
    _countBadge(n, label) {
      if (!n) return "";
      return `
        <span class="preview-card__count">
          <span aria-hidden="true">${n > 99 ? "99+" : n}</span>
          <span class="bgb-vis-hidden">${escapeHtml(label)}</span>
        </span>`;
    }

    _previewCard({ icon, title, sub, route, body, badge = 0, badgeLabel = "" }) {
      return `
        <section class="preview-card">
          ${this._countBadge(badge, badgeLabel)}
          <header class="preview-card__head">
            <span class="preview-card__icon"><i data-icon="${icon}" class="w-4 h-4"></i></span>
            <h3 class="preview-card__title font-display">${escapeHtml(title)}</h3>
            <span class="preview-card__sub">${escapeHtml(sub)}</span>
            <button class="preview-card__seeall" onclick="window.router.go('${route}')">
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
      // owned_page carries prev_owned rows while owned_total counts only what
      // you still have, so a sold game can take a slot in this strip. Dimmed,
      // matching the Collection grid — no stamp, which is unreadable at this
      // size; the title attribute and the spoke behind it carry the detail.
      const parted = item.status === "prev_owned" ? " is-prev-owned" : "";
      return `
        <div class="preview-card__cover${parted}" ${click} title="${escapeAttr(g.name || "")}">
          ${gameArtImg(g, "card", { alt: g.name || "" })
            || `<div class="preview-card__cover-fallback">${escapeHtml((g.name || "?").slice(0, 14))}</div>`}
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
            : `<div class="preview-card__play-thumb preview-card__play-thumb--placeholder"><i data-icon="dice-6" class="w-4 h-4"></i></div>`}
          <div class="preview-card__play-info">
            <div class="preview-card__play-name">
              ${escapeHtml(p.game_name || "")}
              ${youWon ? `<span class="preview-card__play-won"><i data-icon="trophy" class="w-3 h-3"></i> Won</span>` : ""}
            </div>
            ${playerCount > 0 ? `<div class="preview-card__play-meta">${playerCount} ${playerCount === 1 ? "player" : "players"}</div>` : ""}
          </div>
          <div class="preview-card__play-date">${formatDateShort(p.played_at)}</div>
        </li>
      `;
    }
  }

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
