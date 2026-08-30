// views/feed-view.js — Strava-style chronological feed.
//
// Composition:
//   - Optional "resume play" chip when a PlaySession draft is active
//   - Mixed cards from /feed: plays (spine) + hot games / suggested buddies
//     (first page only)
//   - "Load more" tail when next_cursor is set
//   Game search lives on the Host/Join landing now (Find a Game that fits).

(function () {
  // Game ids are UUIDs so this is belt-and-braces, but a selector built from
  // data is a selector that can be broken by data.
  function cssAttrEscape(v) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(v));
    return String(v).replace(/["\\]/g, "\\$&");
  }

  class FeedView extends window.View {
    constructor() {
      super("feed");
      this._page = null;
      this._loading = false;
      this._error = null;
      // How many of _page.cards came from the first page. _load({cursor})
      // appends strictly behind this boundary, so it's what lets an upload
      // replace page one in place without discarding the pages the user
      // scrolled down to — see _onUploadsLanded.
      this._firstPageLen = 0;
      // False until the viewer's collection map is known either way — see
      // onMount. Gates the status corner on every game tile in the feed.
      this._statusReady = false;
    }

    async onMount() {
      this._statusMap = {};
      this._expansionCounts = {};
      // Feed pages paint from cache on the first frame, well before a network
      // round trip could land. Seed the status map from what bootstrap warmed
      // so returning viewers get real "Owned"/"Played" corners in that same
      // frame; when there's nothing warm, `_statusReady` stays false and the
      // corners render empty rather than showing a "+" that later flips to
      // "Owned" — which reads as "you don't have this, add it".
      const warmStatus = window.Collection.cachedStatusMap && window.Collection.cachedStatusMap();
      if (warmStatus) {
        this._statusMap = warmStatus;
        this._statusReady = true;
        // Play cards read the store copy directly (ui/play-card.js), so
        // publish it too. Set before the listeners below are bound: this is a
        // seed, not a change worth re-entering _refreshCollectionData for.
        window.store.set("myCollectionMap", warmStatus);
      } else {
        this._statusReady = false;
      }
      this.listen("feed", () => this.render());
      // Connectivity coming back is the moment a failed first load is worth
      // repeating; _retryInitial no-ops unless we're actually still empty.
      this.listen("offline", (offline) => { if (!offline) this._retryInitial(); });
      this.listen("myCollectionMap", () => this._refreshCollectionData());
      this.listenDom("status-changed", (e) => {
        const { gameId, status } = e.detail || {};
        if (!gameId) return;
        if (status == null) delete this._statusMap[gameId];
        else this._statusMap[gameId] = status;
        this._syncStatusPills(gameId, status);
      });
      this.listenDom("play-changed", (e) => this._onPlayChanged(e.detail || {}));
      this.listenDom("plays-uploaded", (e) => this._onUploadsLanded(e.detail || {}));
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
      } catch (_) {
        // Nothing to show is only right while the answer is still coming. A
        // failed fetch means it isn't — fall back to the "+" so the viewer can
        // still add games.
      }
      this._statusReady = true;
      this.render();
    }

    /**
     * Repaint just the status pills for one game instead of re-rendering the
     * whole feed. A full render() resets the scroll position and flips every
     * open card back over — cheap to ignore when the pill was a corner chip,
     * obvious now that it sits in the card's meta row. Mirrors _syncCardStatus
     * in views/game-explorer-view.js.
     *
     * Nothing to patch is not a problem: _statusMap is already updated above,
     * so a game that isn't on screen picks the new status up on the next paint.
     */
    _syncStatusPills(gameId, status) {
      const root = this.container;
      if (!root) return;
      const sel = cssAttrEscape(gameId);

      // Play cards. The slot is always emitted (it holds an empty string while
      // the collection map is in flight), so this finds the host either way.
      root.querySelectorAll(`.play-card__status-slot[data-game-id="${sel}"]`)
        .forEach((host) => {
          host.innerHTML = window.renderStatusTag(gameId, status || null, {
            size: "sm-row",
            addLabel: "Add",
            gameName: host.dataset.gameName || "",
          });
          this.refreshIcons(host);
        });

      // Hot-games rail tiles render the same game through renderGamePolaroid,
      // so they carry their own host.
      root.querySelectorAll(`.game-polaroid[data-game-id="${sel}"]`)
        .forEach((tile) => {
          tile.setAttribute("data-status", status || "");
          const host = tile.querySelector(".game-polaroid__status");
          if (!host) return;
          host.innerHTML = window.renderStatusTag(gameId, status || null, {
            compact: true,
            gameName: tile.dataset.gameName || "",
          });
          this.refreshIcons(host);
        });
    }

    /**
     * PlayDetailPopup is a modal, not a route — deleting a play from it leaves
     * the feed mounted underneath with the deleted card still painted, and the
     * cache bust inside Play.remove() only takes effect on the next mount. So
     * drop the card from the page we're holding right now, then reconcile with
     * the server in the background.
     *
     * @param {{playId?: string, kind?: string}} detail
     */
    _onPlayChanged({ playId, kind }) {
      // "update" is left alone: the edit popup owns its own repaint and
      // Play.update() already busted the cache for the next mount.
      if (!playId || (kind !== "delete" && kind !== "leave")) return;
      if (!this._page || !Array.isArray(this._page.cards)) return;
      // Count the removals that fell inside the first-page slice so the
      // boundary keeps pointing at the same card — _onUploadsLanded slices on
      // it, and a stale boundary would splice the fresh page over a row that
      // belongs to a cursor page.
      let removedInFirst = 0;
      const cards = this._page.cards.filter((c, i) => {
        const drop = c.kind === "play" && c.play_id === playId;
        if (drop && i < this._firstPageLen) removedInFirst++;
        return !drop;
      });
      if (cards.length === this._page.cards.length) return; // not on this page
      this._page = { ...this._page, cards };
      this._firstPageLen -= removedInFirst;
      // This is the repaint: the new object identity makes store.set fire this
      // view's own listen("feed") subscriber (onMount, above) exactly once. No
      // explicit render() call — that would paint the whole feed twice. The
      // store also has to stay in sync for play-card.js's findCardById
      // fallback. render() re-runs groupCards(), so a session that lost its
      // last play disappears and a two-play session collapses to the single
      // variant on its own — no session-level bookkeeping needed here.
      window.store.set("feed", this._page);
      window.Feed.refreshFirstPage().catch(() => {});
    }

    /**
     * A background outbox flush landed queued plays while the user was sitting
     * on this feed. Without this the new play stays invisible until the next
     * mount: Feed.refreshFirstPage() only re-warms the bgbCache entry, and this
     * view paints from its own _page.
     *
     * Splices the refreshed first page over the slice it replaces rather than
     * replacing _page wholesale — dropping the cursor pages of someone who had
     * scrolled four of them in would yank the screen out from under them.
     *
     * @param {{page?: any, sent?: number}} detail  page is the warm first page
     *   the flush already fetched (domain/outbox.js).
     */
    _onUploadsLanded({ page }) {
      // listenDom unbinds on unmount, so this is belt-and-braces — but the view
      // is a singleton and a leaked listener would paint a hidden screen.
      if (!this._mounted) return;
      // refreshFirstPage only fails when the network went away again mid-flush.
      // Nothing fresh to paint; the next mount re-fetches anyway.
      if (!page || !Array.isArray(page.cards)) return;
      // Still on the skeleton (or a failed first load) — _load owns the first
      // paint and racing it would only get overwritten.
      if (!this._page || !Array.isArray(this._page.cards)) return;

      const tail = this._page.cards.slice(this._firstPageLen);
      // The refreshed page-one window can now extend over rows the tail already
      // holds (it grew by the plays that just uploaded), and groupCards() would
      // emit the same play twice inside one session card.
      const freshIds = new Set(
        page.cards.filter((c) => c.kind === "play" && c.play_id).map((c) => c.play_id),
      );
      const nextCards = [
        ...page.cards,
        ...tail.filter((c) => !(c.kind === "play" && c.play_id && freshIds.has(c.play_id))),
      ];
      // Nothing visibly moved: the flush's refresh can land right after a mount
      // that already fetched the same page, and a needless repaint would cost
      // the user their scroll position for no new content.
      if (cardsSig(nextCards) === cardsSig(this._page.cards)) return;

      this._page = {
        ...this._page,
        cards: nextCards,
        // With a tail, the running cursor belongs to the LAST page fetched, not
        // to the first page we just re-pulled. Without one, the fresh cursor is
        // both correct and newer.
        next_cursor: tail.length ? this._page.next_cursor : page.next_cursor,
      };
      this._firstPageLen = page.cards.length;
      // Known seam: the cards pushed past the old page-one boundary fall into
      // the gap between the new first page and a tail fetched from the old one,
      // so they drop out of the running list until the next mount. That's one
      // card per play this flush uploaded — one or two in practice — against
      // re-fetching every cursor page to close it.
      //
      // Same repaint mechanism as _onPlayChanged: the new object identity makes
      // store.set fire this view's own listen("feed") subscriber exactly once,
      // so there's no render() call here. No skeleton either — render() only
      // paints one while _page is null, and it isn't on this path.
      window.store.set("feed", this._page);
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
          // _firstPageLen stays put: appends land strictly behind it.
        } else {
          this._page = data;
          this._firstPageLen = data.cards.length;
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
      // Nothing loaded AND the load failed. Handled before the normal path
      // because that one falls through to _renderEmpty(), which says "your
      // feed is quiet" — the one reading a failed fetch must never produce:
      // it is wrong, it looks permanent, and it leaves the viewer no way to
      // ask again short of relaunching the app.
      if (!this._page && this._error) {
        this.container.innerHTML = this._renderLoadError();
        this.refreshIcons();
        return;
      }
      const rawCards = (this._page && this._page.cards) || [];
      // Collapse runs of same-day, same-buddy-set plays into a session card.
      // Run on every render so cross-page boundaries fold naturally when new
      // pages append.
      const cards = groupCards(rawCards);
      // The date is a heading above each day's group, not an eyebrow on every
      // session — a game night split across two sets of buddies used to print
      // "Today" twice.
      //
      // A SEEN-DAYS SET, not a "did the day change from the previous card"
      // check: /feed is cursor-paginated by created_at, not played_at (see
      // STRUCTURE.md), and nothing re-sorts client-side — so a back-dated play
      // can land between two same-day plays and a consecutive-run walk would
      // print the same heading twice. Keyed on the raw YYYY-MM-DD string, and
      // rebuilt on every render, so appending a page can't double-print either.
      const seenDays = new Set();
      const body = cards.map((c) => {
        let heading = "";
        if (c.kind === "play_session" && c.played_at && !seenDays.has(c.played_at)) {
          seenDays.add(c.played_at);
          heading = `<h3 class="day-divider">${escapeHtml(formatSessionDate(c.played_at))}</h3>`;
        }
        return heading + this._renderCard(c);
      }).join("");
      // Search pill + avatar moved into the global app header — feed now
      // jumps straight to the resume chip and the card timeline.
      const html = `
        <div class="feed-shell">
          ${this._error ? `<div class="alert alert-error mb-3">${this._error}</div>` : ""}
          <div class="feed-cards">
            ${cards.length === 0 && !this._loading ? this._renderEmpty() : ""}
            ${body}
          </div>
          ${this._renderLoadMore()}
        </div>
      `;
      this.container.innerHTML = html;
      this.refreshIcons();
      // Rail titles that don't fit their 112px tile sweep instead of
      // truncating, and only a post-paint measurement can tell which those
      // are. Infinite scroll re-renders the whole list through here, so
      // appended pages are covered by the same call.
      if (window.scheduleRailTitleFit) window.scheduleRailTitleFit();
      // The sentinel div is replaced on every render — re-observe the
      // new node so infinite scroll keeps firing.
      this._observeSentinel();
    }

    _renderLoadError() {
      return `
        <div class="feed-empty">
          <img src="assets/illustrations/bgb-loading.svg" alt="" style="width:120px;height:120px;opacity:.4" />
          <h3 class="text-lg font-semibold mt-3">Couldn't load your feed</h3>
          <p class="text-sm opacity-70 mt-1">${escapeHtml(this._error)}</p>
          <button class="btn btn-primary btn-sm mt-3"
                  onclick="window.feedView._retryInitial()">Try again</button>
        </div>
      `;
    }

    /**
     * Re-run the first load. Bound to the error state's button and to the
     * `offline` subscription in onMount, so a feed that failed while the user
     * was in a dead zone fills itself in when the signal returns rather than
     * waiting for a tab-switch the user has no reason to make.
     */
    _retryInitial() {
      if (this._loading || this._page) return;
      this._load({ initial: true });
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
        default:
          return "";
      }
    }

    _renderPlaySession(card) {
      // Header reads "You and Sam played 3 games" / "Bill played Catan". The
      // date is not here — render() emits it once per day above the group.
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
      const sessionPlayCount = card.plays.length;
      const isSingle = sessionPlayCount === 1;
      // Annotate each play with the session play count so the polaroid
      // renderer can pick the variant (single vs strip) without re-walking
      // the DOM. The `__`-prefix keeps the field clearly UI-scoped.
      const cards = card.plays
        .map((p) => window.renderPlayCard({ ...p, __sessionPlayCount: sessionPlayCount }))
        .join("");
      return `
        <section class="play-session${isSingle ? " play-session--single" : ""}">
          <header class="play-session__header">
            <span class="play-session__title">${title}</span>
          </header>
          <div class="play-session__scroll">${cards}</div>
        </section>
      `;
    }

    // Shared game-rail component — a heading plus a horizontal strip of game
    // tiles. It used to back two rails ("Hot this week" and the since-removed
    // "Time to revisit"), so it stays parameterised by heading and meta line.
    // Tiles delegate to the canonical Game component per
    // .claude/rules/ui-object-design.md §2.
    /**
     * @param {any} card
     * @param {{icon: string, title: string, meta: (entry: any) => string}} opts
     */
    _renderGameRail(card, { icon, title, meta }) {
      const tiles = (card.games || []).map((entry) => {
        const game = entry.game;
        const status = this._statusMap[game.id] || null;
        const expCount = game.bgg_id ? (this._expansionCounts[game.bgg_id] || 0) : 0;
        return window.renderGamePolaroid(game, {
          variant: "rail",
          collectionStatus: status,
          pending: !this._statusReady,
          meta: meta(entry),
          badgeHtml: window.renderExpansionBadge(expCount),
          clickHandler: `window.router.go('game-detail',{gameId:'${game.id}',gameName:'${jsStr(game.name || "")}'})`,
        });
      }).join("");
      return `
        <section class="feed-rail">
          <header class="feed-rail__header">
            <h3><i data-icon="${icon}" class="w-4 h-4"></i> ${escapeHtml(title)}</h3>
          </header>
          <div class="feed-rail__scroll">${tiles}</div>
        </section>
      `;
    }

    _renderHotGamesCard(card) {
      return this._renderGameRail(card, {
        icon: "flame",
        title: "Hot this week",
        meta: (entry) => `${entry.play_count} plays`,
      });
    }

    // A suggestion carries whichever signals earned it a slot: shared plays,
    // shared buddies, or both. Label the ones it has — "0 mutual" under
    // someone you've played six games with reads like a snub.
    _suggestionReason(s) {
      const parts = [];
      const plays = s.play_count || 0;
      const mutual = s.mutual_count || 0;
      if (plays) parts.push(`${plays} ${plays === 1 ? "play" : "plays"}`);
      if (mutual) parts.push(`${mutual} mutual`);
      return parts.join(" · ");
    }

    _renderSuggestedBuddiesCard(card) {
      const tiles = (card.suggestions || []).map((s) => `
        <div class="buddy-tile">
          <div class="buddy-tile__avatar-wrap"
               onclick="window.router.go('profile-other',{userId:'${s.user_id}'})">
            ${window.BgbBadge.render({ avatar: s.avatar, displayName: s.display_name, size: "md", extraClass: "buddy-tile__avatar" })}
          </div>
          <div class="buddy-tile__name">${escapeHtml(s.display_name)}</div>
          <div class="buddy-tile__mutual">${this._suggestionReason(s)}</div>
          <button class="btn btn-xs btn-primary mt-1"
                  onclick="window.feedView._addBuddy('${s.user_id}', this)">Add</button>
        </div>
      `).join("");
      return `
        <section class="feed-rail">
          <header class="feed-rail__header">
            <h3><i data-icon="user-plus" class="w-4 h-4"></i> Buddies you may know</h3>
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
  // Bucket plays by sessionKey across the whole page. Every play that shares
  // a (played_at, sorted-participant-set) key collapses into one
  // { kind: "play_session", plays: [...] } card no matter what non-play
  // cards (Hot Games, Suggested Buddies) the backend interleaves between
  // them. The session card lands at the
  // position of the FIRST play with that key; non-play cards stay where
  // the backend put them. Single-play sessions still wrap so every feed
  // item carries the gold-bordered section + clickable header.
  //
  // Before: a strict consecutive walk fragmented sessions whenever the
  // backend interleaved a non-play card between two same-key plays — a
  // common case since feed_service.py inserts Suggested-Buddies after the
  // first play on page 1, splitting any game-night whose plays land in the
  // top two slots.

  function groupCards(rawCards) {
    const out = [];
    const sessionByKey = new Map();
    for (const card of rawCards) {
      if (card.kind !== "play") {
        out.push(card);
        continue;
      }
      const key = sessionKey(card);
      let existing = sessionByKey.get(key);
      if (!existing) {
        existing = {
          kind: "play_session",
          played_at: card.played_at,
          participants: card.participants || [],
          plays: [],
        };
        sessionByKey.set(key, existing);
        out.push(existing);
      }
      existing.plays.push(card);
    }
    return out;
  }

  // Identity signature of a card list — what would visibly change if painted.
  // Plays are identified by id; rails by kind alone, since their contents are
  // server-chosen and a reshuffle isn't worth a repaint mid-scroll.
  function cardsSig(cards) {
    return cards.map((c) => (c.kind === "play" ? `p:${c.play_id}` : c.kind)).join("|");
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
        tokens = [{ isViewer: false, html: escapeHtml("Someone") }];
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
      ? `played ${escapeHtml(gameNameForSingle)}`
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
      : `window.router.go('profile-other',{userId:'${escapeHtml(participant.user_id)}'})`;
    return `<a class="play-session__name" onclick="event.stopPropagation(); ${route}">${escapeHtml(label)}</a>`;
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

  function initialsOf(name) {
    const parts = (name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }
  window.FeedView = FeedView;
})();
