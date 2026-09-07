// views/notifications-view.js — the things that happened TO you.
//
// Three signals, one feed, one read watermark:
//
//   play_link       somebody seated your account in a play they logged
//   buddy_request   somebody asked to be your buddy
//   buddy_accepted  somebody accepted the request you sent
//
// All three are things done TO the user rather than by them, and all three used
// to land somewhere else — a play link here, a buddy request as a dot three
// taps into Profile, an acceptance nowhere at all. The bell is the one place
// that answers "what happened while I was away", so it carries all three.
//
// A play_link row is an ENTRY, not a play — one act of linking. The server
// groups a whole imported batch, a run of identical plays, or a single
// retroactive ghost-link into one row (see bgb_notifications), so a 214-play
// import is one line reading "Dana added you to 214 plays" with one tick box,
// rather than 214 lines the user has to select individually. That grouping is
// the difference between this screen being usable and being the same chore in
// a new place.
//
// SELECTION IS THE ROW'S OWN CIRCLE, and it is the only way out of a play. The
// screen used to carry two paths to one destructive action — a per-row ghost
// button that unlinked on the spot, and a header Select toggle that revealed
// tick boxes for the same thing. Two affordances for one destination is the
// anti-pattern in .claude/rules/ui-object-design.md §3b, and the more dangerous
// of the two was the one-tap. Now every play row wears an empty circle, ticking
// any of them raises the action bar, and the bar is where removal happens.
//
// Unlinking hands your seat back as a ghost carrying your name, owned by
// whoever logged the play: they keep their game night, you leave your own
// history. It is not reversible from here — the other person would have to
// link you again — so it goes through the app's one destructive confirm.
//
// Buddy rows are answered in place, through the same POST /buddies/{id}/accept
// and /reject the Buddies screen calls. Same action, same affordance: Decline
// has no confirm there, so it has none here.

(function () {
  const PAGE = 20;
  const SENTINEL_ID = "bgbnotif-sentinel";
  const BAR_ID = "bgbnotif-bar-host";

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
      this._selected = new Set();   // entry_key, play_link rows only
      this._busy = false;           // an unlink is in flight
      this._answering = new Set();  // edge_ids with an accept/decline in flight
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
      // that it returns null and this falls through to the network exactly as
      // it always did. A list of Accept and Remove-me buttons is not a place to
      // paint something old.
      const warm = window.NotificationFeed.peekConfirmed();
      if (warm) this._takePage(warm, { initial: true });
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
        this._takePage(data, { initial: true });
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
     * @param {{initial?: boolean}} [opts]
     */
    _takePage(data, opts) {
      this._items = data.items || [];
      this._firstPageLen = this._items.length;
      this._takeCursor(data);
      this._loaded = true;
      window.NotificationFeed.setUnread(data.unread || 0);
      if (opts && opts.initial) this._error = null;
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
      const n = this._items.length;
      let body;
      if (!n && (!this._loaded || this._loading)) body = this._renderLoader();
      else if (this._error && !n)                 body = this._renderLoadError();
      else if (!n)                                body = this._renderEmpty();
      else                                        body = this._renderList();

      // The bar lives in a host of its own — an empty, unstyled div while
      // nothing is ticked — so raising, relabelling and dropping it patches one
      // node instead of rewriting the screen. See _paintBar().
      this.container.innerHTML =
        `${this._renderHead()}${body}<div id="${BAR_ID}"></div>`;
      this._paintBar();
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
     * The date moved out of the rows and became the thing they sit under. It
     * was the same date twenty times over down the right of the list, which
     * reads as data about each row rather than as where the row falls in time —
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
      const rows = this._groups().map((g) => `
        <h3 class="bgbnotif-day">${escapeHtml(g.label)}</h3>
        ${g.items.map((it) => this._renderRow(it, i++)).join("")}
      `).join("");

      return `
        <div class="bgbnotif-list" aria-label="Notifications">
          ${rows}
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
        const label = formatRelativeDay(it.occurred_at);
        const last = out[out.length - 1];
        if (last && last.label === label) last.items.push(it);
        else out.push({ label, items: [it] });
      }
      return out;
    }

    _renderRow(it, i) {
      if (it.kind === "buddy_request")  return this._renderRequestRow(it, i);
      if (it.kind === "buddy_accepted") return this._renderAcceptedRow(it, i);
      return this._renderPlayRow(it, i);
    }

    /**
     * A play someone seated you in.
     *
     * The circle and the body are siblings, not nested buttons — the same shape
     * the Add Games rows use — so the two taps can't fight over one target: the
     * circle selects, the body opens the play.
     */
    _renderPlayRow(it, i) {
      const picked = this._selected.has(it.entry_key);
      const many = (it.group_count || 1) > 1;
      const who = it.actor_display_name || "Someone";
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

      const what = many ? `these ${it.group_count} plays` : game;

      const art = it.game_thumbnail_url
        ? `<img class="bgbnotif-row__art" src="${escapeAttr(it.game_thumbnail_url)}"
                alt="" loading="lazy" />`
        : `<span class="bgbnotif-row__art bgbnotif-row__art--none" aria-hidden="true">
             <i data-icon="dices" class="w-4 h-4"></i>
           </span>`;

      return `
        <div class="bgbnotif-row ${it.is_unread ? "is-unread" : ""} ${picked ? "is-selected" : ""}"
             data-key="${escapeAttr(it.entry_key)}" style="--i:${i}">
          <button class="bgbnotif-row__pick" type="button"
                  role="checkbox" aria-checked="${picked}"
                  ${this._busy ? "disabled" : ""}
                  data-what="${escapeAttr(what)}"
                  aria-label="${picked ? "Deselect" : "Select"} ${escapeAttr(what)}"
                  onclick="window.notificationsView._toggle('${jsStr(it.entry_key)}')">
            ${this._pickIcon(picked)}
          </button>
          <button class="bgbnotif-row__main" type="button"
                  onclick="window.notificationsView._open('${jsStr(it.play_id)}')">
            ${this._badge(it)}
            ${art}
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
        displayName: it.actor_display_name || "Someone",
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

    /**
     * The action bar, which exists only while something is ticked.
     *
     * Two buttons and no third: get out of what you picked, or put it back.
     * There is no Select all — the old bar carried one, and "select all" on a
     * list whose only action is destructive is a button whose entire job is to
     * arm the worst possible version of it.
     */
    _renderBar() {
      const n = this._selected.size;
      if (!n) return "";
      return `
        <div class="bgbnotif-bar">
          <button class="bgbnotif-bar__clear" type="button" ${this._busy ? "disabled" : ""}
                  onclick="window.notificationsView._clearSelection()">
            Clear selection
          </button>
          <button class="bgbnotif-bar__go" type="button" ${this._busy ? "disabled" : ""}
                  onclick="window.notificationsView._unlinkSelected()">
            ${this._busy ? "Removing…" : `Remove me from ${this._playCount()}`}
          </button>
        </div>
      `;
    }

    _pickIcon(picked) {
      return `<i data-icon="${picked ? "check-circle" : "circle"}" class="w-5 h-5"></i>`;
    }

    // ── Surgical paints ─────────────────────────────────────────────────────
    //
    // Ticking a row is a FIELD change, not a structural one: the same rows in
    // the same order, one of them wearing a tick. Sending it through render()
    // rewrites the container, which re-runs the staggered `fadeUp` on all
    // twenty rows (styles.css .bgbnotif-row), re-hydrates every icon, re-decodes
    // every thumbnail and destroys the very button the finger is on before
    // :active can apply — the whole screen visibly reloading between two taps
    // that changed nothing but a circle. So the three field-only changes on
    // this screen — the tick, the bar, the in-flight buddy answer — patch their
    // own node. render() stays for structural changes: a page arriving, a row
    // leaving, a load failing. See .claude/rules/web-frontend.md
    // ("Re-render surgically, not the whole screen") and
    // .claude/rules/overlays.md §6.

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

    /** One row's tick: the ring, the circle, and what a screen reader hears. */
    _paintPick(key) {
      const row = this._rowEl(key);
      if (!row) return;
      const picked = this._selected.has(key);
      row.classList.toggle("is-selected", picked);
      const btn = row.querySelector(".bgbnotif-row__pick");
      if (!btn) return;
      btn.setAttribute("aria-checked", String(picked));
      btn.setAttribute("aria-label",
        `${picked ? "Deselect" : "Select"} ${btn.getAttribute("data-what") || ""}`.trim());
      btn.innerHTML = this._pickIcon(picked);
      this.refreshIcons(btn);
    }

    /** The action bar, raised, relabelled or dropped, in its own host. */
    _paintBar() {
      const host = document.getElementById(BAR_ID);
      if (!host) return;
      host.innerHTML = this._renderBar();
      this.refreshIcons(host);
    }

    /** The Accept/Decline pair on one buddy row, in flight or back again. */
    _paintAnswer(key) {
      const row = this._rowEl(key);
      const host = row && row.querySelector(".bgbnotif-row__actions");
      const it = this._items.find((x) => x.entry_key === key);
      if (!host || !it) return;
      host.innerHTML = this._renderAnswer(it);
      this.refreshIcons(host);
    }

    /**
     * The disabled sweep an in-flight unlink puts over its own controls.
     *
     * Same reasoning as the tick: the rows do not change, so the list does not
     * repaint — and this one runs immediately after a destructive confirm, where
     * a full reload of the screen reads as the action having already happened.
     */
    _paintBusy() {
      const host = this.container;
      if (host) {
        for (const btn of host.querySelectorAll(".bgbnotif-row__pick")) {
          btn.disabled = this._busy;
        }
      }
      this._paintBar();
    }

    /** Plays, not rows: one ticked import is 214 plays and must say so. */
    _playCount() {
      const n = this._items
        .filter((it) => this._selected.has(it.entry_key))
        .reduce((sum, it) => sum + (it.group_count || 1), 0);
      return `${n} ${n === 1 ? "play" : "plays"}`;
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    _retry() { this._load({ initial: true }); }

    _open(playId) { window.PlayDetailPopup.show(playId); }

    _openProfile(userId) {
      if (userId) window.router.go("profile-other", { userId });
    }

    _toggle(key) {
      if (this._busy) return;
      if (this._selected.has(key)) this._selected.delete(key);
      else this._selected.add(key);
      this._paintPick(key);
      this._paintBar();
    }

    _clearSelection() {
      if (this._busy) return;
      const was = Array.from(this._selected);
      this._selected.clear();
      for (const key of was) this._paintPick(key);
      this._paintBar();
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
      this._selected.delete(key);
      // The prefetched page still carries this row, and re-opening the bell
      // inside its confirmed window would offer Accept for a request that is
      // already answered. Patched, not dropped — the rest of the page is still
      // good, and it is the whole reason the screen opens instantly.
      window.NotificationFeed.dropFromPage(key);
      if (window.Buddy && window.Buddy.setPendingCount) {
        window.Buddy.setPendingCount(window.Buddy.pendingCount() - 1);
      }
    }

    async _unlinkSelected() {
      const picked = this._items.filter((it) => this._selected.has(it.entry_key));
      if (picked.length) await this._unlink(picked);
    }

    /**
     * The one destructive write this screen performs.
     *
     * A batch entry rides as its `import_batch_id` rather than as its expanded
     * play ids: the server resolves it under the same ownership scoping either
     * way, and one field beats a request body carrying 214 UUIDs.
     */
    async _unlink(entries) {
      if (this._busy) return;
      const plays = entries.reduce((s, it) => s + (it.group_count || 1), 0);
      const me = window.store.get("user");
      const name = (me && me.display_name) || "your name";

      const ok = await window.PolaroidPopup.confirm({
        title: plays === 1 ? "Remove yourself from this play?"
                           : `Remove yourself from ${plays} plays?`,
        body: `You'll show up as a ghost called "${name}" on them instead, and they'll `
            + `stop counting towards your stats. Whoever logged them keeps the games. `
            + `You can't undo this here — they'd have to add you back.`,
        confirmLabel: "Remove me",
        cancelLabel: "Keep them",
        destructive: true,
      });
      if (!ok) return;

      this._busy = true;
      this._paintBusy();

      const sel = { playIds: [], groupIds: [], batchIds: [] };
      for (const it of entries) {
        if (it.play_group === "batch" && it.import_batch_id) {
          sel.batchIds.push(it.import_batch_id);
        } else {
          sel.playIds.push(...(it.play_ids || [it.play_id]));
        }
      }

      try {
        await window.NotificationFeed.unlink(sel);
        showToast(plays === 1 ? "Removed you from the play"
                              : `Removed you from ${plays} plays`, "success");
        this._selected.clear();
        // Reload from the top rather than splicing: the rows below just moved
        // up under a cursor that no longer points at what it did, and the
        // unread count has to come back from the server anyway.
        await this._load({ initial: true });
      } catch (e) {
        await window.PolaroidPopup.alert({
          title: "Couldn't remove you",
          body: (e && e.message) || "Something went wrong. Try again in a moment.",
        });
      } finally {
        this._busy = false;
        // The success path already reloaded the list; the failure path left it
        // exactly as it was, still ticked, and only needs its controls back.
        this._paintBusy();
      }
    }
  }

  window.NotificationsView = NotificationsView;
})();
