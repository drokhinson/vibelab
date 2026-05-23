// views/feed-view.js — Strava-style chronological feed.
//
// Composition:
//   - Optional "resume play" chip when a PlaySession draft is active
//   - Mixed cards from /feed: plays (spine) + hot games / suggested buddies /
//     featured-from-collection (first page only)
//   - "Load more" tail when next_cursor is set
//   Game search lives on the Host/Join landing now (Find a Game that fits).

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
      const rawCards = (this._page && this._page.cards) || [];
      // Collapse runs of same-day, same-buddy-set plays into a session card.
      // Run on every render so cross-page boundaries fold naturally when new
      // pages append.
      const cards = groupCards(rawCards);
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
        case "play_session":
          return this._renderPlaySession(card);
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

    _renderPlaySession(card) {
      // Header reads "You and Sam played 3 games" / "Bill played Catan".
      // Names are clickable: viewer's own name → profile-self, others →
      // profile-other. Each play inside the rail still reuses
      // renderPlayCard so flip / no-flip subtrees / state map keep
      // working — the rail is purely a layout wrapper.
      const me = window.store && window.store.get && window.store.get("user");
      const viewer = me ? { id: me.id, display_name: me.display_name } : null;
      const firstPlay = card.plays[0];
      // When the session is a single play, surface the game name in the
      // title ("You played Catan") instead of the count.
      const gameNameForSingle = (card.plays.length === 1 && firstPlay && firstPlay.game)
        ? firstPlay.game.name
        : null;
      const title = formatSessionTitleHtml({
        participants: card.participants || [],
        viewer,
        loggerFallback: firstPlay && firstPlay.user,
        gameCount: card.plays.length,
        gameNameForSingle,
      });
      const dateLabel = formatSessionDate(card.played_at);
      const sessionPlayCount = card.plays.length;
      // Annotate each play with the session play count so the polaroid
      // renderer can pick the variant (single vs strip) without re-walking
      // the DOM. The `__`-prefix keeps the field clearly UI-scoped.
      const cards = card.plays
        .map((p) => window.renderPlayCard({ ...p, __sessionPlayCount: sessionPlayCount }))
        .join("");
      return `
        <section class="play-session">
          <header class="play-session__header">
            <span class="play-session__title">${title}</span>
            <span class="play-session__date">${escape(dateLabel)}</span>
          </header>
          <div class="play-session__scroll">${cards}</div>
        </section>
      `;
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
          <div class="buddy-tile__avatar-wrap"
               onclick="window.router.go('profile-other',{userId:'${s.user_id}'})">
            ${window.BgbBadge.render({ avatar: s.avatar, displayName: s.display_name, size: "md", extraClass: "buddy-tile__avatar" })}
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

  // ── Same-day session grouping ─────────────────────────────────────────────
  //
  // The backend orders plays by (played_at DESC, created_at DESC) so plays
  // that share a (date, buddy-set) bucket arrive contiguously. We walk the
  // play cards once and bucket runs of same-key cards into a synthetic
  // { kind: "play_session", plays: [...] } card. Single plays also wrap so
  // every feed item carries the gold-bordered section + clickable header.
  // Non-play cards (hot games rail etc.) break a run because they're rare
  // and only ever appear on page 1.

  function groupCards(rawCards) {
    const out = [];
    let i = 0;
    while (i < rawCards.length) {
      const card = rawCards[i];
      if (card.kind !== "play") {
        out.push(card);
        i++;
        continue;
      }
      const key = sessionKey(card);
      let j = i + 1;
      while (j < rawCards.length && rawCards[j].kind === "play" && sessionKey(rawCards[j]) === key) {
        j++;
      }
      const plays = rawCards.slice(i, j);
      out.push({
        kind: "play_session",
        played_at: card.played_at,
        participants: card.participants || [],
        plays,
      });
      i = j;
    }
    return out;
  }

  function sessionKey(card) {
    // Backend already filtered participants to viewer + buddies and sorted
    // by display name. Stringify the user_id list to get a stable key.
    // Fallback to the logger id in the (unexpected) event the play has no
    // visible participants — keeps consecutive same-day, same-logger plays
    // merged instead of fragmenting them.
    const ids = (card.participants && card.participants.length)
      ? card.participants.map((p) => p.user_id).join(",")
      : `logger:${(card.user && card.user.id) || ""}`;
    return `${card.played_at}|${ids}`;
  }

  // ── Session header ────────────────────────────────────────────────────────

  function formatSessionTitleHtml({ participants, viewer, loggerFallback, gameCount, gameNameForSingle }) {
    // Build a "name token" list. Each token has { html, isViewer } where
    // html is the already-escaped, possibly-anchored name span. We rotate
    // "You" to position 0 when the viewer is among the participants.
    let tokens = (participants || []).map((p) => ({
      isViewer: viewer && p.user_id === viewer.id,
      html: nameLinkHtml(p, viewer),
    }));
    if (tokens.length === 0) {
      // Defensive fallback: backend should always include at least the
      // logger when the play is visible. If somehow empty, render the
      // logger directly (or "Someone" if even that's missing).
      if (loggerFallback && loggerFallback.id) {
        tokens = [{
          isViewer: viewer && loggerFallback.id === viewer.id,
          html: nameLinkHtml(
            { user_id: loggerFallback.id, display_name: loggerFallback.display_name || "Someone" },
            viewer,
          ),
        }];
      } else {
        tokens = [{ isViewer: false, html: escape("Someone") }];
      }
    }
    // Float "You" to the front.
    const viewerIdx = tokens.findIndex((t) => t.isViewer);
    if (viewerIdx > 0) {
      const [me] = tokens.splice(viewerIdx, 1);
      tokens.unshift(me);
    }
    let who;
    if (tokens.length === 1) who = tokens[0].html;
    else if (tokens.length === 2) who = `${tokens[0].html} and ${tokens[1].html}`;
    else if (tokens.length === 3) who = `${tokens[0].html}, ${tokens[1].html}, and ${tokens[2].html}`;
    else {
      const others = tokens.length - 2;
      who = `${tokens[0].html}, ${tokens[1].html}, and ${others} others`;
    }
    // Single-play sessions surface the game name; multi-play sessions
    // count games. The session header is the only place either appears
    // now that the card front dropped its "User played Game" line.
    const trailing = gameNameForSingle
      ? `played ${escape(gameNameForSingle)}`
      : `played ${gameCount} games`;
    return `${who} ${trailing}`;
  }

  function nameLinkHtml(participant, viewer) {
    // Viewer's own row → profile-self (the router's no-arg self profile
    // route, registered as 'profile-self'). Anyone else → profile-other
    // with their user_id. stopPropagation so the click doesn't bubble
    // into a parent flippable card (the session header isn't inside a
    // .play-card today, but defensive in case it ever is).
    const isViewer = viewer && participant.user_id === viewer.id;
    const label = isViewer ? "You" : (participant.display_name || "Someone");
    const route = isViewer
      ? `window.router.go('profile-self')`
      : `window.router.go('profile-other',{userId:'${escape(participant.user_id)}'})`;
    return `<a class="play-session__name" onclick="event.stopPropagation(); ${route}">${escape(label)}</a>`;
  }

  function formatSessionDate(iso) {
    if (!iso) return "";
    // Match play-card.js's formatPlayedAt — parse Y-M-D as local so
    // Today/Yesterday doesn't drift across UTC boundaries.
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = m
      ? new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
      : new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (sameDay(d, today)) return "Today";
    if (sameDay(d, yesterday)) return "Yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
