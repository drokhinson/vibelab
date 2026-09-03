// @ts-check
// domain/link-notification.js — "somebody put me in a play".
//
// Anyone can seat your account in a play they log, and until this existed that
// write was silent and one-sided. This is the data layer behind the header
// bell and views/notifications-view.js.
//
// NOT A CORE OBJECT, deliberately (.claude/rules/ui-object-design.md §1). A
// link notification shows on exactly one surface, routes to no detail screen
// of its own — tapping one opens the Play it is about, through the app's
// existing PlayDetailPopup — and has one mutation. It is a projection over
// Play, so it gets no canonical component in ui/ and no row in ARCHITECTURE.md
// §3. If a second surface ever renders one, that is the moment to extract.
//
// The server derives the list rather than storing events; see
// services/link_notification_service.py for why. The consequence here is that
// unlinking needs no list bookkeeping beyond dropping the row locally — the
// next fetch simply will not contain it.

/**
 * @typedef {Object} LinkNotification
 * @property {string} entry_key      Stable id for the ENTRY (not a play id)
 * @property {"batch"|"run"|"act"} kind
 * @property {string} play_id        Representative play — what the card opens
 * @property {string[]} play_ids     Every play in the entry
 * @property {number} group_count
 * @property {number} game_count
 * @property {string|null} played_from
 * @property {string|null} played_to
 * @property {string} linked_at
 * @property {string|null} game_id
 * @property {string|null} game_name
 * @property {string|null} game_thumbnail_url
 * @property {string|null} owner_id
 * @property {string|null} owner_display_name
 * @property {string|null} owner_username
 * @property {Object|null} owner_avatar
 * @property {string|null} import_batch_id
 * @property {boolean} is_unread
 */

(function () {
  const LinkNotifications = {
    /**
     * One page of entries, newest first.
     *
     * Not cached through bgbCache: the whole value of this screen is that it
     * is current, and it is opened rarely and deliberately. A stale page here
     * would offer an Unlink button for a seat that is already gone.
     *
     * @param {{limit?: number, before?: string|null}} [opts]
     * @returns {Promise<{items: LinkNotification[], next_cursor: string|null, unread: number}>}
     */
    list(opts) {
      const o = opts || {};
      return window.api.get("/link-notifications", {
        limit: o.limit || 20,
        before: o.before || undefined,
      });
    },

    /**
     * Advance the read watermark.
     *
     * `through` is the newest `linked_at` the user was actually SHOWN, not
     * "now": a link landing between the list request and this call would
     * otherwise be marked seen without ever having been on screen. The server
     * merges monotonically, so a stale retry cannot walk the watermark back.
     *
     * @param {string|null} [through]
     * @returns {Promise<{seen_at: string, unread: number}>}
     */
    markSeen(through) {
      return window.api.post("/link-notifications/seen", { through: through || null })
        .then((r) => {
          LinkNotifications.setUnread((r && r.unread) || 0);
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
      return window.api.post("/link-notifications/unlink", {
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
    unreadCount() { return window.store.get("linkNotifCount") || 0; },

    /** @param {number} n */
    setUnread(n) {
      window.store.set("linkNotifCount", Math.max(0, Math.floor(Number(n) || 0)));
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
      const n = payload.link_notifications_unread;
      if (n == null) return;
      LinkNotifications.setUnread(n);
    },
  };

  window.LinkNotifications = LinkNotifications;
})();
