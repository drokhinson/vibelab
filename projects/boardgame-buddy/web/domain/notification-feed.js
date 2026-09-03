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
  const NotificationFeed = {
    /**
     * One page of the merged feed, newest first.
     *
     * Not cached through bgbCache: the whole value of this screen is that it is
     * current, and it is opened rarely and deliberately. A stale page here
     * would offer Remove me for a seat that is already gone, or Accept for a
     * request already answered somewhere else.
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
      return window.api.get("/notifications", {
        limit: o.limit || 20,
        before: o.before || undefined,
        before_key: o.beforeKey || undefined,
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
          return r;
        });
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
     * Seed the bell from the boot payload.
     *
     * Reads the payload's own top-level key, not `profile_bundle` — the
     * backend gathers this count beside the bundle rather than inside it.
     * A missing key means an older backend, and no-ops to leave the dot dark
     * rather than claiming zero, exactly as GhostClaim's equivalent does.
     *
     * @param {Object|null} payload
     */
    publishUnreadFromBoot(payload) {
      if (!payload) return;
      const n = payload.notifications_unread;
      if (n == null) return;
      NotificationFeed.setUnread(n);
    },
  };

  window.NotificationFeed = NotificationFeed;
})();
