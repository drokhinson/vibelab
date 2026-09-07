// @ts-check
// domain/notification-feed.js — the things that happened TO you.
//
// Three signals share one feed, one cursor and one read watermark: somebody
// seated you in a play they logged, somebody asked to be your buddy, somebody
// accepted the request you sent. This is the data layer behind the header bell
// and views/notifications-view.js.
//
// NOT A CORE OBJECT, deliberately (.claude/rules/ui-object-design.md §1). A
// notification shows on exactly one surface and routes to no detail screen of
// its own — tapping one opens the thing it is ABOUT, through the app's existing
// PlayDetailPopup or profile-other route. It is a projection over Play and
// Buddy, so it gets no canonical component in ui/ and no row in
// ARCHITECTURE.md §3. If a second surface ever renders one, that is the moment
// to extract.
//
// The server derives the list rather than storing events; see
// services/notification_service.py for why. Two consequences here: unlinking
// needs no list bookkeeping beyond dropping the row locally, and neither does
// answering a buddy request — the next fetch simply will not contain it.

/**
 * @typedef {Object} Notification
 * @property {string} entry_key   Stable id for the ENTRY, and the cursor tiebreak
 * @property {"play_link"|"buddy_request"|"buddy_accepted"} kind
 * @property {string} occurred_at
 * @property {boolean} is_unread
 * @property {string|null} actor_id            Whoever did this
 * @property {string|null} actor_display_name
 * @property {string|null} actor_username
 * @property {Object|null} actor_avatar
 * @property {"batch"|"run"|"act"|null} [play_group]  play_link only, below here
 * @property {string|null} [play_id]           Representative — what the row opens
 * @property {string[]|null} [play_ids]        Every play in the entry
 * @property {number|null} [group_count]
 * @property {number|null} [game_count]
 * @property {string|null} [played_from]
 * @property {string|null} [played_to]
 * @property {string|null} [game_id]
 * @property {string|null} [game_name]
 * @property {string|null} [game_thumbnail_url]
 * @property {string|null} [import_batch_id]
 * @property {string|null} [edge_id]           buddy_request / buddy_accepted only
 */

(function () {
  const NS = "notif";
  const FIRST_KEY = "first";

  // How long a fetched first page still counts as the truth.
  //
  // This is NOT the app's usual stale-while-revalidate window, and the entry is
  // deliberately written with freshTtl === staleTtl so bgbCache can never serve
  // it past this line. Every other cached namespace happily paints something
  // old while it refreshes; this one must not. Its rows carry Accept, Decline
  // and Remove-me — offering an action for a request answered on another device
  // is worse than a spinner, which is the reasoning this module used to give for
  // not caching at all.
  //
  // What changed is not the tolerance, it is WHEN the fetch happens. The page
  // is now prefetched — /bootstrap carries it, a focus re-warm renews it, and
  // touching the bell starts one — so in the ordinary "open the app, see the
  // dot, tap it" path the request has already landed and the screen paints in
  // one frame. Past this window the view goes back to waiting on the network,
  // which is exactly what it did before.
  //
  // 20s is short on purpose. Raising it buys instant paints further from a
  // fetch and pays for them in freshness; this is the one number to change.
  const CONFIRMED_MS = 20 * 1000;

  const NotificationFeed = {
    /**
     * One page of the merged feed, newest first.
     *
     * The first page is served from the last fetch when that fetch is younger
     * than CONFIRMED_MS, and re-fetched otherwise — see the constant. Cursor
     * pages are never cached: each one is a one-shot window keyed by a cursor
     * nothing else will ever ask for again.
     *
     * bgbCache also single-flights per key, which is what makes prefetching
     * worth anything: a warm() started on the bell's pointerdown and the view's
     * own read a moment later join ONE request rather than opening two.
     *
     * The cursor is a PAIR. Three sources feeding one ordering makes ties on
     * `occurred_at` ordinary rather than rare, and a cursor on the timestamp
     * alone silently drops every row sharing a page boundary — so `beforeKey`
     * travels with `before` and both come from the previous response.
     *
     * @param {{limit?: number, before?: string|null, beforeKey?: string|null}} [opts]
     * @returns {Promise<{items: Notification[], next_cursor: string|null, next_cursor_key: string|null, unread: number}>}
     */
    list(opts) {
      const o = opts || {};
      const limit = o.limit || 20;
      if (o.before) {
        return window.api.get("/notifications", {
          limit,
          before: o.before,
          before_key: o.beforeKey || undefined,
        });
      }
      return window.bgbCache.swr(
        NS,
        FIRST_KEY,
        () => window.api.get("/notifications", { limit }),
        { freshTtl: CONFIRMED_MS, staleTtl: CONFIRMED_MS },
      );
    },

    /**
     * The warm first page, or null — synchronous, never touches the network.
     *
     * Read through bgbCache.get() rather than peek() precisely because get()
     * stops at the fresh window while peek() serves the stale one. There is no
     * stale window here (freshTtl === staleTtl), so the two would agree today;
     * using get() is what keeps them agreeing if anyone ever widens the pair.
     *
     * The view calls this before its first await so a confirmed page paints in
     * the mount frame instead of after a skeleton.
     *
     * @returns {{items: Notification[], next_cursor: string|null, next_cursor_key: string|null, unread: number}|null}
     */
    peekConfirmed() {
      return window.bgbCache.get(NS, FIRST_KEY);
    },

    /**
     * Start (or join) a first-page fetch nobody is waiting on yet.
     *
     * Fire-and-forget by design: every caller is speculating that the user is
     * about to open the bell, and a speculation that fails must not surface an
     * error. Inside the confirmed window this is a no-op, so calling it on
     * every focus and every bell touch costs nothing.
     *
     * @returns {Promise<void>}
     */
    warm() {
      return NotificationFeed.list({}).then(() => {}, () => {});
    },

    /** Drop the warm page. Any mutation that changes what page one contains. */
    invalidate() {
      window.bgbCache.delete(NS, FIRST_KEY);
    },

    /**
     * Drop the warm page and fetch a new one. Pull-to-refresh's entry point,
     * and the only read that deliberately ignores the confirmed window.
     *
     * @param {{limit?: number}} [opts]
     */
    refreshFirstPage(opts) {
      NotificationFeed.invalidate();
      return NotificationFeed.list({ limit: (opts && opts.limit) || 20 });
    },

    /**
     * Seed the warm page from the boot payload.
     *
     * The page inside /bootstrap was built by the same service call this
     * module's own fetch makes, at the moment the app booted — so it enters the
     * cache as what it is, a fetch that just completed, and ages out of the
     * confirmed window on the same clock as any other.
     *
     * @param {Object|null} page
     */
    seedFirstPage(page) {
      if (!page || !Array.isArray(page.items)) return;
      window.bgbCache.setWithTtls(NS, FIRST_KEY, page, {
        freshTtl: CONFIRMED_MS,
        staleTtl: CONFIRMED_MS,
      });
    },

    /**
     * Advance the read watermark.
     *
     * `through` is the newest `occurred_at` the user was actually SHOWN, not
     * "now": a notification landing between the list request and this call
     * would otherwise be marked seen without ever having been on screen. The
     * server merges monotonically, so a stale retry cannot walk the watermark
     * back.
     *
     * @param {string|null} [through]
     * @returns {Promise<{seen_at: string, unread: number}>}
     */
    markSeen(through) {
      return window.api.post("/notifications/seen", { through: through || null })
        .then((r) => {
          NotificationFeed.setUnread((r && r.unread) || 0);
          // The warm page still says these rows are unread, and the next open
          // inside the confirmed window would paint that: a list of rows lit up
          // as new, under a bell with no dot. Patch the flags rather than
          // dropping the entry — the rows themselves are still correct, and
          // discarding them would throw away the prefetch this whole path
          // exists to deliver.
          NotificationFeed._markPageSeen(through);
          return r;
        });
    },

    /**
     * Clear is_unread through `stamp` on the warm page, in place.
     *
     * Mirrors the server's watermark exactly: bgb_notifications computes
     * is_unread as occurred_at > watermark, and the watermark just advanced to
     * `stamp`. A null stamp means the server defaulted to now(), which covers
     * everything the page holds.
     *
     * @param {string|null} [stamp]
     */
    _markPageSeen(stamp) {
      const page = window.bgbCache.get(NS, FIRST_KEY);
      if (!page || !Array.isArray(page.items)) return;
      const items = page.items.map((it) =>
        (it.is_unread && (!stamp || it.occurred_at <= stamp))
          ? { ...it, is_unread: false }
          : it);
      window.bgbCache.setWithTtls(
        NS, FIRST_KEY, { ...page, items, unread: 0 },
        { freshTtl: CONFIRMED_MS, staleTtl: CONFIRMED_MS },
      );
    },

    /**
     * Drop one row from the warm page, in place.
     *
     * An answered buddy request is gone from the server's derived feed the
     * instant the edge flips or is deleted — so leaving it on the prefetched
     * page would put Accept and Decline back in front of the user next time
     * they open the bell inside the confirmed window, for a request they have
     * already answered. That is precisely the staleness this module refuses to
     * serve.
     *
     * Patched rather than invalidated so the prefetch survives the action: the
     * remaining rows are still exactly what the server would send, and
     * next_cursor is keyed on the last row, which this cannot be — the view
     * only ever drops a row it is looking at, and the cursor row is the one it
     * pages FROM.
     *
     * @param {string} entryKey
     */
    dropFromPage(entryKey) {
      const page = window.bgbCache.get(NS, FIRST_KEY);
      if (!page || !Array.isArray(page.items)) return;
      const items = page.items.filter((it) => it.entry_key !== entryKey);
      if (items.length === page.items.length) return;
      window.bgbCache.setWithTtls(
        NS, FIRST_KEY, { ...page, items },
        { freshTtl: CONFIRMED_MS, staleTtl: CONFIRMED_MS },
      );
    },

    /**
     * Remove yourself from plays, whole runs, or whole imports.
     *
     * Batches ride as `import_batch_ids` rather than as their expanded play
     * ids — one field instead of a request body carrying 214 UUIDs — and the
     * server resolves them under the same ownership scoping either way.
     *
     * @param {{playIds?: string[], groupIds?: string[], batchIds?: string[]}} sel
     * @returns {Promise<{rows_updated: number}>}
     */
    unlink(sel) {
      const s = sel || {};
      return window.api.post("/notifications/unlink", {
        play_ids: s.playIds || [],
        import_group_ids: s.groupIds || [],
        import_batch_ids: s.batchIds || [],
      }).then((r) => {
        // The rows just removed are ON the warm page — serving it again would
        // re-offer Remove me for seats that are already gone.
        NotificationFeed.invalidate();
        // Same busting any other play mutation does. ONE call for the whole
        // batch, not one per id — _invalidatePlayDeps() drops whole cache
        // namespaces, so repeating it per play would be the same work sixty
        // times over.
        if (window.Play && window.Play.invalidateDeps) window.Play.invalidateDeps();
        // An unlinked play may have been the "Another Round" seed, and it is
        // no longer in this user's history to offer.
        if (window.Play && window.Play.rememberLastPlay) window.Play.rememberLastPlay(null);
        // The app's existing cross-view channel. `leave-bulk` rather than
        // `leave` because a mounted feed cannot splice out an unknown number
        // of cards by id — it reloads instead (see feed-view).
        document.dispatchEvent(new CustomEvent("play-changed", {
          detail: { kind: "leave-bulk", playIds: s.playIds || [] },
        }));
        return r;
      });
    },

    /** @returns {number} */
    unreadCount() { return window.store.get("notifCount") || 0; },

    /** @param {number} n */
    setUnread(n) {
      window.store.set("notifCount", Math.max(0, Math.floor(Number(n) || 0)));
    },

    /**
     * Seed the bell AND the screen behind it from the boot payload.
     *
     * Reads the payload's own top-level keys, not `profile_bundle` — the
     * backend gathers both beside the bundle rather than inside it. Missing
     * keys mean an older backend: the count no-ops to leave the dot dark rather
     * than claiming zero (exactly as GhostClaim's equivalent does), and the
     * page no-ops to leave the screen fetching for itself, which is what it did
     * before this existed.
     *
     * The count is read from its own key rather than from the page's `unread`
     * so an older backend that sends one and not the other still lights the dot
     * correctly.
     *
     * @param {Object|null} payload
     */
    publishUnreadFromBoot(payload) {
      if (!payload) return;
      NotificationFeed.seedFirstPage(payload.notifications_first_page);
      const n = payload.notifications_unread;
      if (n == null) return;
      NotificationFeed.setUnread(n);
    },
  };

  window.NotificationFeed = NotificationFeed;
})();
