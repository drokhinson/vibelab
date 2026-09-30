// views/notifications-view.js — the things that happened TO you.
//
// Two sections. "Needs an answer" sits on top and holds what waits on the
// user: play invites and buddy requests, oldest first, each with Accept and
// Decline. Everything else is under it, newest first, by day:
//
//   play_link       a play you are in that somebody else logged
//   buddy_accepted  somebody accepted the request you sent
//   play_inherited  a play passed to you when its logger deleted their account
//
// A play somebody seats you in is an INVITE until you answer it: it shows on
// the play as you, but counts toward nothing of yours. Invites arrive whole on
// the first page (`invites`), outside the paged list, so an old one never
// hides three pages down. Answering one moves it: accepted, it becomes an
// ordinary play_link row below; declined, it is gone.
//
// An invite is an ENTRY, not a play. The server groups a whole imported batch
// or a run of identical plays into one (see bgb_play_invites), so a 214-play
// import is one row reading "Kim added you to 214 plays" with Accept all and
// Review. Review lists the plays so single nights can be declined first.
//
// Declining leaves your seat as a guest carrying your name, owned by whoever
// logged the play: they keep their game night, and it never counted for you.
// Leaving a play you already accepted is the play card's "I didn't play —
// remove me", not this screen's.
//
// Buddy rows are answered in place, through the same POST /buddies/{id}/accept
// and /reject the Buddies screen calls. Same action, same affordance: Decline
// has no confirm there, so it has none here, and neither does declining a
// play invite, which loses nothing that ever counted.

(function () {
  const PAGE = 20;
  const SENTINEL_ID = "bgbnotif-sentinel";

  class NotificationsView extends window.View {
    constructor() {
      super("notifications");
      this._resetState();
    }

    // Every transient field in one place, called from the constructor AND the
    // top of onMount. This view is a singleton that survives logout->login and
    // back-stack pops, so a previous session's selection would otherwise be
    // sitting under the next mount — attached, here, to a destructive button.
    _resetState() {
      this._items = [];
      // How many of _items came from page one. _loadMore() appends strictly
      // behind this boundary, so it is what lets a pull-to-refresh replace page
      // one in place without discarding the pages the user scrolled down to —
      // the same bookkeeping views/feed-view.js keeps for the same reason.
      this._firstPageLen = 0;
      this._cursor = null;        // {before, beforeKey} — the tuple keyset
      this._hasMore = false;
      this._loading = false;
      this._loaded = false;
      this._error = null;
      this._invites = [];           // unanswered play invites, oldest first
      this._answering = new Set();  // edge_ids and invite entry_keys with an answer in flight
      this._seq = 0;
    }

    async onMount() {
      this._resetState();
      this._io = this._io || new window.InfiniteScroll({
        onLoadMore: () => this._loadMore(),
      });
      // A failed first load offers Retry, but a user who walks back into signal
      // shouldn't have to find it.
      this.listen("offline", (off) => {
        if (!off && this._error && !this._items.length) this._load({ initial: true });
      });

      // THE WHOLE POINT OF THE PREFETCH, and it has to happen before the first
      // await or it buys nothing: everything below this line runs in the mount
      // frame, so a page /bootstrap already fetched paints in the same frame the
      // bell was tapped in, with no skeleton between.
      //
      // peekConfirmed() answers only while that fetch is recent enough to still
      // be the truth (see CONFIRMED_MS in domain/notification-feed.js) — past
      // that it returns null and this falls through to the network. A list of
      // Accept and Remove-me buttons is not a place to
      // paint something old.
      // A play opened from this list can be answered on its own card. The
      // invite it stood for is then stale, and so is the list around it.
      this.listenDom("play-changed", (e) => {
        const { kind, playId } = e.detail || {};
        if (kind !== "accept" && kind !== "leave") return;
        if (this._invites.some((it) => (it.play_ids || [it.play_id]).includes(playId))) {
          this._load({ initial: true });
        }
      });

      // An app left open on this screen shows the list it was mounted with, so
      // coming back to it re-pulls page one.
      this.listenDom("visibilitychange", () => {
        if (document.visibilityState === "visible") this._refresh();
      });

      const warm = window.NotificationFeed.peekConfirmed();
      if (warm) this._takePage(warm);
      this.render();

      if (warm) {
        // _load's own finally clause normally does this; the warm path skips
        // _load entirely, and the watermark still has to move.
        if (this._items.length) this._markSeen();
      } else {
        await this._load({ initial: true });
      }
      this._attachPull();
    }

    /** The bell (or a tapped push) routed here while already open. */
    onParamsChange() {
      return this._refresh();
    }

    async onUnmount() {
      // A hidden view keeps its markup, so an unparked sentinel would keep
      // pulling pages nobody is looking at.
      if (this._io) this._io.disconnect();
      if (this._ptr) this._ptr.detach();
    }

    _attachPull() {
      if (!window.PullToRefresh || !window.PullToRefresh.supported) return;
      this._ptr = this._ptr || new window.PullToRefresh({
        host: this.container,
        onRefresh: () => this._refresh(),
      });
      this._ptr.attach();
    }

    renderLoading() {
      this.container.innerHTML = `${this._renderHead()}${this._renderLoader()}`;
      this.refreshIcons();
    }

    // ── Data ────────────────────────────────────────────────────────────────

    async _load({ initial = false } = {}) {
      const seq = ++this._seq;
      this._loading = true;
      if (initial) { this._error = null; this._cursor = null; }
      this.render();
      try {
        const data = await window.NotificationFeed.list({ limit: PAGE });
        if (seq !== this._seq) return;          // a newer load owns the screen
        this._takePage(data);
      } catch (e) {
        if (seq !== this._seq) return;
        // Its own branch, not an empty state: "nothing has happened" next to a
        // dead network is a lie, and it looks permanent.
        this._error = (e && e.message) || "Couldn't load notifications.";
      } finally {
        if (seq === this._seq) {
          this._loading = false;
          this.render();
          // Only once the list is actually on screen: a failed load must not
          // clear the bell for notifications the user never saw.
          if (!this._error && this._items.length) this._markSeen();
        }
      }
    }

    async _loadMore() {
      if (this._loading || !this._hasMore || this._error) return;
      const seq = this._seq;
      const cursor = this._cursor || {};
      this._loading = true;
      this.render();
      try {
        const data = await window.NotificationFeed.list({
          limit: PAGE, before: cursor.before, beforeKey: cursor.beforeKey,
        });
        if (seq !== this._seq) return;
        this._items = this._items.concat(data.items || []);
        this._takeCursor(data);
      } catch (_) {
        if (seq !== this._seq) return;
        // Stop the sentinel rather than retrying the same failing request on
        // every scroll. The footer offers a manual retry.
        this._hasMore = false;
      } finally {
        if (seq === this._seq) { this._loading = false; this.render(); }
      }
    }

    /**
     * Adopt a first page — from the network, from the warm prefetch, or from a
     * pull-to-refresh. One writer for the four fields that have to move
     * together, because three callers each setting three of them is how
     * _firstPageLen drifts out of step with _items.
     *
     * @param {Object} data
     */
    _takePage(data) {
      this._items = data.items || [];
      this._firstPageLen = this._items.length;
      this._takeCursor(data);
      this._loaded = true;
      this._error = null;
      this._takeInvites(data);
      window.NotificationFeed.setUnread(data.unread || 0);
    }

    /** The first page's invites and the bell's pending count. */
    _takeInvites(data) {
      this._invites = data.invites || [];
      if (data.pending != null) window.NotificationFeed.setPending(data.pending);
    }

    /**
     * Pull-to-refresh: re-pull page one and splice it over the page-one slice,
     * KEEPING the cursor pages below it. A user four pages deep who pulls to
     * see what's new must not be dropped back to a single page.
     *
     * Rows are reconciled by entry_key: anything the fresh page carries is
     * dropped from the tail, so a notification that moved (a play entry whose
     * batch grew, and whose occurred_at therefore advanced) appears once, at its
     * new position, rather than twice.
     *
     * The seam is the same one feed-view documents for its upload path: rows
     * pushed past the old page-one boundary fall into the gap between the new
     * first page and a tail fetched from the old one, so they drop out of the
     * running list until the next mount. That is the cost of not re-fetching
     * every cursor page, and it is bounded by how much arrived since.
     */
    async _refresh() {
      const seq = this._seq;
      let data;
      try {
        data = await window.NotificationFeed.refreshFirstPage({ limit: PAGE });
      } catch (_) {
        // A refresh that fails leaves the list exactly as it was, which is the
        // honest outcome — the rows on screen are still the rows the server
        // last gave us. The error branch is for a list that has nothing.
        if (!this._items.length) { this._error = "Couldn't load notifications."; this.render(); }
        return;
      }
      if (seq !== this._seq) return;   // a load or a re-mount owns the screen now

      const fresh = data.items || [];
      const freshKeys = new Set(fresh.map((it) => it.entry_key));
      const tail = this._items
        .slice(this._firstPageLen)
        .filter((it) => !freshKeys.has(it.entry_key));

      this._items = fresh.concat(tail);
      this._firstPageLen = fresh.length;
      // With a tail, the running cursor belongs to the LAST page fetched, not to
      // the first page we just re-pulled. Without one, the fresh cursor is both
      // correct and newer.
      if (!tail.length) this._takeCursor(data);
      this._loaded = true;
      this._error = null;
      this._takeInvites(data);
      window.NotificationFeed.setUnread(data.unread || 0);
      this.render();
      // Whatever arrived is now on screen, so it counts as read — same rule as
      // the initial load, and the same reason the stamp is the newest
      // occurred_at SHOWN rather than now().
      if (this._items.length) this._markSeen();
    }

    // The cursor is a PAIR, and both halves have to travel. Three sources feed
    // one ordering, so ties on occurred_at are ordinary rather than rare, and a
    // cursor carrying only the timestamp silently drops every row that shares a
    // page boundary with the last one shown.
    _takeCursor(data) {
      this._cursor = data.next_cursor
        ? { before: data.next_cursor, beforeKey: data.next_cursor_key }
        : null;
      this._hasMore = !!data.next_cursor;
    }

    // Send the newest occurred_at we actually SHOWED, not "now": a notification
    // landing between the list request and this call would otherwise be marked
    // seen without ever having been on screen. The server merges monotonically.
    _markSeen() {
      const newest = this._items.reduce(
        (max, it) => (!max || it.occurred_at > max ? it.occurred_at : max), null);
      window.NotificationFeed.markSeen(newest).catch(() => {});
    }

    // ── Render ──────────────────────────────────────────────────────────────

    render() {
      const n = this._items.length + this._invites.length;
      let body;
      if (!n && (!this._loaded || this._loading)) body = this._renderLoader();
      else if (this._error && !n)                 body = this._renderLoadError();
      else if (!n)                                body = this._renderEmpty();
      else                                        body = this._renderList();

      this.container.innerHTML = `${this._renderHead()}${body}`;
      this.refreshIcons();

      // Re-point every paint: the host's contents are replaced each time, so a
      // long-lived observation would end up watching a detached node.
      if (this._io) {
        this._io.observe(
          this._hasMore ? document.getElementById(SENTINEL_ID) : null);
      }
    }

    // No close ×. The bell in the global header is this screen's only opener,
    // so it is also its closer (init.js#toggleNotifications), and the device
    // back button already means the same thing. A third control for one exit is
    // chrome the user has to learn instead of chrome that gets out of the way.
    _renderHead() {
      return `
        <header class="spoke-head">
          <h2 class="spoke-head__title font-display">Notifications</h2>
        </header>
      `;
    }

    _renderLoader() {
      return window.buddyLoader({ size: 96, label: "Loading notifications…" });
    }

    _renderLoadError() {
      return `
        <div class="bgbnotif-state" role="alert">
          <p class="bgbnotif-state__title">Couldn't load notifications.</p>
          <p class="bgbnotif-state__sub">${escapeHtml(this._error || "")}</p>
          <button class="btn btn-primary btn-sm"
                  onclick="window.notificationsView._retry()">Try again</button>
        </div>
      `;
    }

    _renderEmpty() {
      return `
        <div class="bgbnotif-state">
          <img class="bgbnotif-state__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <p class="bgbnotif-state__title">Nothing has happened yet.</p>
          <p class="bgbnotif-state__sub">
            When someone puts you in a game they logged, asks to be your buddy,
            or accepts a request you sent, it shows up here.
          </p>
        </div>
      `;
    }

    /**
     * The list, under day headers.
     *
     * The date is the thing the rows sit under, not a column on each: the
     * same date twenty times over down the right of the list reads as data
     * about each row rather than as where the row falls in time —
     * and the date a notification list is actually read on is when the thing
     * HAPPENED, not when the game was played. The play date stays on its row as
     * a detail; the header carries the position.
     *
     * Flat markup rather than a wrapper per group: the headers are `sticky`, so
     * each one has to resolve against the page's scrollport rather than a box
     * that ends where the group does.
     */
    _renderList() {
      let i = 0;
      const owed = this._owed();
      const needs = owed.length ? `
        <h3 class="bgbnotif-day bgbnotif-day--owed">
          Needs an answer <span class="bgbnotif-day__count">${owed.length}</span>
        </h3>
        ${owed.map((it) => this._renderRow(it, i++)).join("")}
      ` : "";
      const groups = this._groups();
      const rows = groups.map((g, gi) => `
        <h3 class="bgbnotif-day">${escapeHtml(owed.length && gi === 0 ? `Earlier · ${g.label}` : g.label)}</h3>
        ${g.items.map((it) => this._renderRow(it, i++)).join("")}
      `).join("");

      return `
        <div class="bgbnotif-list" aria-label="Notifications">
          ${needs}${rows}
        </div>
        ${window.InfiniteScroll.renderFooter({
          id: SENTINEL_ID,
          hasMore: this._hasMore,
          loading: this._loading,
          error: null,
          onRetry: "window.notificationsView._loadMore()",
          endLabel: "",
        })}
      `;
    }

    /**
     * Consecutive runs of the same day, in list order.
     *
     * Built off the already-sorted list rather than by bucketing into a map, so
     * an appended page merges into the last group when the day matches instead
     * of opening a second "Today" further down.
     */
    _groups() {
      const out = [];
      for (const it of this._items) {
        if (it.kind === "buddy_request") continue;   // listed under Needs an answer
        const label = formatRelativeDay(it.occurred_at);
        const last = out[out.length - 1];
        if (last && last.label === label) last.items.push(it);
        else out.push({ label, items: [it] });
      }
      return out;
    }

    /**
     * What waits on an answer, oldest first: the invites, and the buddy
     * requests the loaded pages carry. A request is received rarely enough to
     * sit on the first page, so lifting it out of the day groups is enough to
     * keep the two kinds of question in one place.
     */
    _owed() {
      const requests = this._items.filter((it) => it.kind === "buddy_request");
      return this._invites.concat(requests)
        .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
    }

    _renderRow(it, i) {
      if (it.kind === "play_invite")     return this._renderInviteRow(it, i);
      if (it.kind === "buddy_request")   return this._renderRequestRow(it, i);
      if (it.kind === "buddy_accepted")  return this._renderAcceptedRow(it, i);
      if (it.kind === "play_inherited")  return this._renderInheritedRow(it, i);
      return this._renderPlayRow(it, i);
    }

    /**
     * A play that passed to you because the account that logged it was deleted.
     *
     * A GHOST BADGE, because the person is not an account any more — the same
     * silhouette their seat on the play now renders as, so the row and the
     * scorecard agree about what happened to them. `actor_display_name` is read
     * straight rather than through `Buddy.nameFor`: an alias lives on a buddy
     * edge, and the edge went with the account.
     *
     * The sub-line says out loud that the play is editable. Inheriting one
     * hands over edit and delete rights on a record somebody else wrote, and
     * this row is the only place that is ever said.
     */
    _renderInheritedRow(it, i) {
      const who = it.actor_display_name || "Someone";
      const game = it.game_name || "a game";

      const badge = window.BgbBadge.render({
        size: "sm",
        displayName: who,
        isGhost: true,
        extraClass: "bgbnotif-row__who",
      });

      return `
        <div class="bgbnotif-row ${it.is_unread ? "is-unread" : ""}"
             data-key="${escapeAttr(it.entry_key)}" style="--i:${i}">
          <button class="bgbnotif-row__main" type="button"
                  onclick="window.notificationsView._open('${jsStr(it.play_id)}')">
            ${badge}
            ${this._art(it)}
            <span class="bgbnotif-row__body">
              <span class="bgbnotif-row__title">${`<strong>${escapeHtml(who)}</strong> deleted their account — their ${escapeHtml(game)} play is yours now`}</span>
              <span class="bgbnotif-row__sub">${this._span(it)} · yours to edit or delete</span>
            </span>
          </button>
        </div>
      `;
    }

    /**
     * A play you are in that somebody else logged, already counted: you
     * accepted it, or joined it yourself. Opening it is the only action here.
     */
    _renderPlayRow(it, i) {
      const many = (it.group_count || 1) > 1;
      // Under the viewer's private alias — the row is about a play they were
      // both at, so it names them the way the play's own roster does.
      const who = window.Buddy.nameFor(it.actor_id, it.actor_display_name) || "Someone";
      const game = it.game_name || "a game";

      // A run says how big it is and over how many games; a single play names
      // the game and when it was played. Both are one sentence, because the
      // question the row answers is "what happened and who did it".
      const title = many
        ? `<strong>${escapeHtml(who)}</strong> added you to ${it.group_count} plays`
        : `<strong>${escapeHtml(who)}</strong> added you to ${escapeHtml(game)}`;
      const sub = many
        ? `${it.game_count > 1 ? `${it.game_count} games · ` : `${escapeHtml(game)} · `}${this._span(it)}`
        : this._span(it);

      return `
        <div class="bgbnotif-row ${it.is_unread ? "is-unread" : ""}"
             data-key="${escapeAttr(it.entry_key)}" style="--i:${i}">
          <button class="bgbnotif-row__main" type="button"
                  onclick="window.notificationsView._open('${jsStr(it.play_id)}')">
            ${this._badge(it)}
            ${this._art(it)}
            <span class="bgbnotif-row__body">
              <span class="bgbnotif-row__title">${title}</span>
              <span class="bgbnotif-row__sub">${sub}</span>
            </span>
            ${many ? `<span class="bgbnotif-row__count">${it.group_count}</span>` : ""}
          </button>
        </div>
      `;
    }

    /**
     * A play somebody seated you in, waiting on your answer.
     *
     * One play: Accept and Decline, answered in place. Several (an import, a
     * run): Accept all, and Review, which lists the plays so single nights
     * can be declined before the rest are accepted. The body opens the play
     * either way, where the same question is asked above the roster.
     */
    _renderInviteRow(it, i) {
      const many = (it.group_count || 1) > 1;
      const who = window.Buddy.nameFor(it.actor_id, it.actor_display_name) || "Someone";
      const game = it.game_name || "a game";
      const title = many
        ? `<strong>${escapeHtml(who)}</strong> added you to ${it.group_count} plays`
        : `<strong>${escapeHtml(who)}</strong> added you to ${escapeHtml(game)}`;
      const sub = many
        ? `${it.game_count > 1 ? `${it.game_count} games · ` : `${escapeHtml(game)} · `}${this._span(it)}`
        : this._span(it);

      return `
        <div class="bgbnotif-row bgbnotif-row--owed ${it.is_unread ? "is-unread" : ""}"
             data-key="${escapeAttr(it.entry_key)}" style="--i:${i}">
          <button class="bgbnotif-row__main" type="button"
                  onclick="window.notificationsView._open('${jsStr(it.play_id)}')">
            ${this._badge(it)}
            ${this._art(it)}
            <span class="bgbnotif-row__body">
              <span class="bgbnotif-row__title">${title}</span>
              <span class="bgbnotif-row__sub">${sub}</span>
            </span>
          </button>
          <span class="bgbnotif-row__actions">${this._renderInviteAnswer(it)}</span>
        </div>
      `;
    }

    /** The invite's two buttons, or the stub that stands in while one is in flight. */
    _renderInviteAnswer(it) {
      const many = (it.group_count || 1) > 1;
      const key = jsStr(it.entry_key);
      if (this._answering.has(it.entry_key)) {
        return `<button class="bgbnotif-row__accept" type="button" disabled>Working…</button>`;
      }
      return `
        <button class="bgbnotif-row__accept" type="button"
                onclick="window.notificationsView._acceptInvite('${key}')">
          ${many ? "Accept all" : "Accept"}
        </button>
        <button class="bgbnotif-row__decline" type="button"
                onclick="window.notificationsView._${many ? "reviewInvite" : "declineInvite"}('${key}', this)">
          ${many ? "Review" : "Decline"}
        </button>
      `;
    }

    /** The game's thumbnail, or the dice mark when the play has none. */
    _art(it) {
      return it.game_thumbnail_url
        ? `<img class="bgbnotif-row__art" src="${escapeAttr(it.game_thumbnail_url)}"
                alt="" loading="lazy" />`
        : `<span class="bgbnotif-row__art bgbnotif-row__art--none" aria-hidden="true">
             <i data-icon="dices" class="w-4 h-4"></i>
           </span>`;
    }

    /**
     * Somebody wants to be your buddy — answered where it is read.
     *
     * No select circle: the action bar removes you from plays, and a buddy
     * request is not a play. Reserving the circle's column anyway would promise
     * a tick that never comes.
     */
    _renderRequestRow(it, i) {
      const who = it.actor_display_name || "Someone";
      return `
        <div class="bgbnotif-row bgbnotif-row--buddy ${it.is_unread ? "is-unread" : ""}"
             data-key="${escapeAttr(it.entry_key)}" style="--i:${i}">
          <button class="bgbnotif-row__main" type="button"
                  onclick="window.notificationsView._openProfile('${jsStr(it.actor_id)}')">
            ${this._badge(it)}
            <span class="bgbnotif-row__art bgbnotif-row__art--none" aria-hidden="true">
              <i data-icon="user-plus" class="w-4 h-4"></i>
            </span>
            <span class="bgbnotif-row__body">
              <span class="bgbnotif-row__title">
                <strong>${escapeHtml(who)}</strong> wants to be buddies
              </span>
              <span class="bgbnotif-row__sub">${this._handle(it)}</span>
            </span>
          </button>
          <span class="bgbnotif-row__actions">${this._renderAnswer(it)}</span>
        </div>
      `;
    }

    /**
     * The Accept/Decline pair, or the disabled stub that replaces it while one
     * of them is in flight.
     *
     * Its own renderer because _paintAnswer() re-paints exactly this cluster:
     * the two states have to be produced by one function or the in-place swap
     * drifts from the first paint.
     */
    _renderAnswer(it) {
      const who = it.actor_display_name || "Someone";
      if (this._answering.has(it.edge_id)) {
        return `<button class="bgbnotif-row__accept" type="button" disabled>Working…</button>`;
      }
      return `
        <button class="bgbnotif-row__accept" type="button"
                aria-label="Accept ${escapeAttr(who)}'s buddy request"
                onclick="window.notificationsView._answer('${jsStr(it.entry_key)}','${jsStr(it.edge_id)}',true)">
          Accept
        </button>
        <button class="bgbnotif-row__decline" type="button"
                aria-label="Decline ${escapeAttr(who)}'s buddy request"
                onclick="window.notificationsView._answer('${jsStr(it.entry_key)}','${jsStr(it.edge_id)}',false)">
          Decline
        </button>
      `;
    }

    /** Somebody accepted the request you sent. Nothing to answer; go say hello. */
    _renderAcceptedRow(it, i) {
      const who = it.actor_display_name || "Someone";
      return `
        <div class="bgbnotif-row bgbnotif-row--buddy ${it.is_unread ? "is-unread" : ""}"
             data-key="${escapeAttr(it.entry_key)}" style="--i:${i}">
          <button class="bgbnotif-row__main" type="button"
                  onclick="window.notificationsView._openProfile('${jsStr(it.actor_id)}')">
            ${this._badge(it)}
            <span class="bgbnotif-row__art bgbnotif-row__art--none" aria-hidden="true">
              <i data-icon="user-check" class="w-4 h-4"></i>
            </span>
            <span class="bgbnotif-row__body">
              <span class="bgbnotif-row__title">
                <strong>${escapeHtml(who)}</strong> accepted your buddy request
              </span>
              <span class="bgbnotif-row__sub">${this._handle(it)}</span>
            </span>
          </button>
        </div>
      `;
    }

    /**
     * The sub-line on a buddy row.
     *
     * A play row's sub-line answers "which game, when"; a buddy row has no
     * equivalent fact, and the obvious filler — "Tap to see their profile" —
     * is an instruction dressed as information, on a row whose whole body is
     * visibly a button. The handle is the one thing worth saying: it is how
     * the user finds this person again, and it is what tells two Daves apart.
     */
    _handle(it) {
      return it.actor_username ? `@${escapeHtml(it.actor_username)}` : "";
    }

    _badge(it) {
      return window.BgbBadge.render({
        size: "sm",
        displayName: window.Buddy.nameFor(it.actor_id, it.actor_display_name) || "Someone",
        avatar: it.actor_avatar,
        extraClass: "bgbnotif-row__who",
      });
    }

    /** "12 Aug 2019" for one play, "Mar 2019 – Aug 2024" for a run that spans. */
    _span(it) {
      const from = it.played_from, to = it.played_to;
      if (!from && !to) return "date unknown";
      if (!from || !to || from === to) return formatDate(from || to);
      return `${formatDate(from)} – ${formatDate(to)}`;
    }

    // ── Surgical paints ─────────────────────────────────────────────────────
    //
    // An answer going in flight is a FIELD change, not a structural one: the
    // same rows in the same order, one of them showing "Working…". Sending it
    // through render() rewrites the container, which re-runs the staggered
    // `fadeUp` on every row (styles.css .bgbnotif-row), re-hydrates every icon,
    // re-decodes every thumbnail and destroys the very button the finger is
    // on. So the in-flight answer patches its own node, and render() stays for
    // structural changes: a page arriving, a row leaving, a load failing. See
    // .claude/rules/web-frontend.md ("Re-render surgically, not the whole
    // screen") and .claude/rules/overlays.md §6.

    /** The row element carrying `key`, or null if it isn't painted. */
    _rowEl(key) {
      const host = this.container;
      if (!host) return null;
      // Walked rather than selected: an entry_key is server-supplied and goes
      // into an attribute selector unescaped otherwise.
      for (const el of host.querySelectorAll(".bgbnotif-row[data-key]")) {
        if (el.getAttribute("data-key") === key) return el;
      }
      return null;
    }

    /** The Accept/Decline pair on one buddy row, in flight or back again. */
    _paintAnswer(key) {
      const row = this._rowEl(key);
      const host = row && row.querySelector(".bgbnotif-row__actions");
      const invite = this._invites.find((x) => x.entry_key === key);
      const it = invite || this._items.find((x) => x.entry_key === key);
      if (!host || !it) return;
      host.innerHTML = invite ? this._renderInviteAnswer(invite) : this._renderAnswer(it);
      this.refreshIcons(host);
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    _retry() { this._load({ initial: true }); }

    _open(playId) { window.PlayDetailPopup.show(playId); }

    _openProfile(userId) {
      if (userId) window.router.go("profile-other", { userId });
    }

    /**
     * Accept or decline a buddy request, in place.
     *
     * The row is dropped locally on success rather than reloaded: the feed is
     * derived from the edge itself, so an answered request is gone from the
     * next fetch too, and reloading would scroll the user back to the top of a
     * list they were reading.
     *
     * A 409 means somebody answered it somewhere else — the Buddies screen,
     * another device — while this list was open. That is the expected cost of a
     * derived feed and not an error worth a dialog: the row is stale either
     * way, so it goes, quietly.
     */
    async _answer(key, edgeId, accept) {
      if (!edgeId || this._answering.has(edgeId)) return;
      this._answering.add(edgeId);
      // Only this row's two buttons become "Working…" — the list around it is
      // unchanged, and a user answering three requests in a row should not
      // watch the screen rebuild between each one.
      this._paintAnswer(key);
      let dropped = false;
      try {
        if (accept) await window.Buddy.accept(edgeId);
        else await window.Buddy.reject(edgeId);
        this._dropRow(key);
        dropped = true;
        showToast(accept ? "You're buddies now" : "Request declined",
                  accept ? "success" : "info");
      } catch (e) {
        // 409/404 means the edge is no longer pending — somebody answered it on
        // the Buddies screen or another device while this list was open. The
        // row is stale either way, so it goes, quietly. Anything else (a dead
        // network, a 500) leaves the request genuinely unanswered, so the row
        // STAYS: dropping it would hide a request the user still owes a reply
        // to, and would walk the Profile dot down for a change that never
        // landed.
        if (e && (e.status === 409 || e.status === 404)) { this._dropRow(key); dropped = true; }
        else showToast((e && e.message) || "Couldn't answer that request", "error");
      } finally {
        this._answering.delete(edgeId);
        // A dropped row is a structural change — the list is shorter and the
        // rows below it moved — so that one repaints. A row that stayed only
        // needs its two buttons back.
        if (dropped) this.render();
        else this._paintAnswer(key);
      }
    }

    /**
     * Drop one answered request and tell the rest of the app.
     *
     * The pending count is decremented rather than recomputed: this screen
     * holds one page of a feed, not the incoming-request list, so it cannot
     * know the true total. The Buddies screen and the next boot both publish
     * the authoritative number, and setPendingCount clamps at zero, so the
     * worst a drift can do is under-count a dot until then.
     */
    _dropRow(key) {
      // Where it sat decides whether the page-one boundary moves: a row from a
      // cursor page leaves it alone. A boundary that drifts would make the next
      // pull-to-refresh splice the fresh page over a row belonging to a page
      // below it.
      const i = this._items.findIndex((x) => x.entry_key === key);
      this._items = this._items.filter((x) => x.entry_key !== key);
      if (i > -1 && i < this._firstPageLen) this._firstPageLen--;
      // The prefetched page still carries this row, and re-opening the bell
      // inside its confirmed window would offer Accept for a request that is
      // already answered. Patched, not dropped — the rest of the page is still
      // good, and it is the whole reason the screen opens instantly.
      window.NotificationFeed.dropFromPage(key);
      if (window.Buddy && window.Buddy.setPendingCount) {
        window.Buddy.setPendingCount(window.Buddy.pendingCount() - 1);
      }
      window.NotificationFeed.setPending(window.NotificationFeed.pendingCount() - 1);
    }

    /** @param {string} key */
    _invite(key) { return this._invites.find((x) => x.entry_key === key) || null; }

    /**
     * Take an answered invite off the screen. Accepted, it comes back as a
     * play_link row on the next fetch, so the first page is re-pulled in the
     * background; declined, it is simply gone.
     */
    _dropInvite(key, { accepted }) {
      this._invites = this._invites.filter((x) => x.entry_key !== key);
      window.NotificationFeed.setPending(window.NotificationFeed.pendingCount() - 1);
      this.render();
      if (accepted) this._refresh();
    }

    async _acceptInvite(key) {
      const it = this._invite(key);
      if (!it || this._answering.has(key)) return;
      this._answering.add(key);
      this._paintAnswer(key);
      const n = it.group_count || 1;
      try {
        await window.NotificationFeed.acceptInvites(it.play_ids || [it.play_id]);
        this._answering.delete(key);
        this._dropInvite(key, { accepted: true });
        showToast(n === 1 ? "Added to your stats" : `Added ${n} plays to your stats`, "success");
      } catch (e) {
        this._answering.delete(key);
        this._paintAnswer(key);
        showToast((e && e.message) || "Couldn't accept that play", "error");
      }
    }

    async _declineInvite(key) {
      const it = this._invite(key);
      if (!it || this._answering.has(key)) return;
      this._answering.add(key);
      this._paintAnswer(key);
      try {
        await window.NotificationFeed.unlink({ playIds: it.play_ids || [it.play_id] });
        this._answering.delete(key);
        this._dropInvite(key, { accepted: false });
        showToast("Declined", "info");
      } catch (e) {
        this._answering.delete(key);
        this._paintAnswer(key);
        showToast((e && e.message) || "Couldn't decline that play", "error");
      }
    }

    /** A grouped invite, play by play. Whatever was answered there reloads the list. */
    _reviewInvite(key, btn) {
      const it = this._invite(key);
      if (!it) return;
      window.BgbInviteReviewSheet.open({
        who: window.Buddy.nameFor(it.actor_id, it.actor_display_name) || "Someone",
        playIds: it.play_ids || [it.play_id],
        returnFocus: btn || null,
        onDone: () => this._load({ initial: true }),
      });
    }
  }

  window.NotificationsView = NotificationsView;
})();
