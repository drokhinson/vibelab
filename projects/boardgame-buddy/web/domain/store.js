// domain/store.js — Namespaced pub/sub store. Replaces the legacy
// state.js global-let pattern with a single Store instance whose namespaces
// (session, feed, closet, activePlay, search) survive view unmount/remount.

(function () {
  class Store {
    constructor() {
      this._data = {
        session: null,        // Supabase auth session
        user: null,           // CurrentUser shape from /profile
        feed: null,           // FeedPageResponse (most recent first-page fetch)
        // gameId → status. null = not loaded yet, which readers must NOT paint
        // as "owns nothing"; {} = loaded and the viewer has nothing. See
        // domain/collection.js.
        myCollectionMap: null,
        feedCursor: null,     // ISO timestamp of next page (null = none)
        feedLoading: false,
        activePlay: null,     // PlaySession serialized form (see play-session.js)
        search: null,         // last UnifiedSearchResponse
        currentView: "splash",
        currentRoute: { name: "splash", params: {} },
        offline: false,       // BgbNet.isOffline() — see domain/net.js
        outboxCount: 0,       // plays queued for upload — see domain/outbox.js
        theme: "dark",        // "light" | "dark" — see domain/theme.js
        // The BGG comparison / sync run, published by domain/bgg-sync-flow.js.
        // Lives here rather than on either surface because the flow's screen
        // and the Settings progress strip are never mounted at the same time.
        bggSync: null,
        // Catalog imports pulled from BoardGameGeek this session, published by
        // domain/bgg-import.js as an ImportJob[]. Here rather than on the
        // import sheet because an import OUTLIVES it — the sheet is one
        // subscriber, the completion notification is another, and neither is
        // guaranteed to be on screen when a job settles.
        bggImport: [],
        // Pending INCOMING buddy requests. The app's one notification signal:
        // the Profile nav tab paints a dot from it, the hub's Buddies card
        // paints the number. Lives here rather than on either surface because
        // neither is mounted when the other needs the figure — see
        // domain/buddy.js#setPendingCount for who writes it.
        buddyRequestCount: 0,
        // Earned badges this device has not shown yet — the second half of
        // the same signal, published by domain/achievements.js. Two slots
        // rather than one total: the nav dot only needs "something is
        // waiting", but each hub card names its own count.
        achievementUnseenCount: 0,
        // Pending INCOMING ghost account claims (migration 070) — someone
        // asking to link one of this user's ghost players to their account.
        // Third source on the same dot; the hub's Buddies card sums it with
        // buddyRequestCount, since both resolve behind that one card.
        ghostClaimRequestCount: 0,
        // "Is this you?" — ghosts on a BUDDY's roster that look like this
        // user, still awaiting a "That's me" or a "Not me". The other
        // direction from ghostClaimRequestCount above, and the fourth source
        // on the same dot. Counted by domain/ghost-claim.js, which holds the
        // key set behind it; only rows with no claim of their own count, since
        // a row already asked for comes back with claim_status='pending'.
        ghostClaimSuggestionCount: 0,
        // Admin review queues, published by domain/admin-review.js from one
        // /admin/review-counts call. Three slots rather than one total for the
        // same reason as the ghost-claim pair above: the gear's dot only needs
        // "something is waiting", but each row of the Settings admin card
        // names its own count. All three stay 0 for non-admins, which is what
        // keeps the dot dark for everyone else.
        adminChapterReportCount: 0,
        adminMissingImageCount: 0,
        adminMissingDescriptionCount: 0,
        // Everything that has happened TO this account and it hasn't looked at
        // yet: plays somebody seated it in, buddy requests received, requests
        // of its own that were accepted. Published by
        // domain/notification-feed.js — from the boot payload on launch, and
        // from the list itself once the screen is open. The play part counts
        // ACTS, not plays: one imported batch of 214 is 1 here, which is what
        // the notifications screen shows as one row.
        notifCount: 0,
      };
      // Which slot feeds which nav tab and which hub card is domain/
      // notifications.js's table, not this file's business — store is a signal
      // bus. Adding a slot here is half the job; the other half is a row there.
      this._subs = new Map(); // key → Set<fn>
    }

    get(key) { return this._data[key]; }

    set(key, value) {
      const prev = this._data[key];
      if (prev === value) return;
      this._data[key] = value;
      const subs = this._subs.get(key);
      if (subs) {
        for (const fn of subs) {
          try { fn(value, prev); } catch (e) { console.error("Store sub error", e); }
        }
      }
    }

    // Manually fire a change without mutating — used by `invalidate('feed')` so
    // any subscribed view re-fetches.
    invalidate(key) {
      const subs = this._subs.get(key);
      if (subs) {
        for (const fn of subs) {
          try { fn(this._data[key], this._data[key]); } catch (e) { console.error(e); }
        }
      }
    }

    // Returns an unsubscribe fn. Views should call this in `unmount()`.
    subscribe(key, fn) {
      if (!this._subs.has(key)) this._subs.set(key, new Set());
      this._subs.get(key).add(fn);
      return () => this._subs.get(key).delete(fn);
    }

    reset() {
      this._data = {
        session: null,
        user: null,
        feed: null,
        feedCursor: null,
        feedLoading: false,
        myCollectionMap: null,
        activePlay: null,
        search: null,
        currentView: "splash",
        currentRoute: { name: "splash", params: {} },
        // Re-seeded from their owners rather than zeroed: reset() runs on
        // logout, and neither the device's connectivity nor the plays already
        // queued on disk stop being true because someone signed out. Zeroing
        // them here would also desync BgbNet's edge-tracking, which suppresses
        // a publish when the value it last published is unchanged.
        offline: !!(window.BgbNet && window.BgbNet.isOffline()),
        outboxCount: window.Outbox ? window.Outbox.count() : 0,
        // Same reasoning again: the painted theme isn't a session value, and
        // logout must not leave the key undefined for subscribers.
        theme: window.BgbTheme ? window.BgbTheme.current() : "dark",
        // Zeroed on purpose, unlike the two above: whoever signs in next has
        // their own graph, and a leftover dot would announce someone else's
        // requests on the new account's Profile tab.
        buddyRequestCount: 0,
        // Same: Achievements.forget() wipes the device receipts on sign-out,
        // so the count they backed goes with them.
        achievementUnseenCount: 0,
        // And the same again: the next account's ghosts are not this one's.
        ghostClaimRequestCount: 0,
        // Nor are the next account's near-matches. GhostClaim.forgetSuggestions()
        // drops the key set that backs this on the same sign-out.
        ghostClaimSuggestionCount: 0,
        // Zeroed as well: admin is a property of the account that just signed
        // out, so a leftover count would light the gear for whoever signs in
        // next — and for a non-admin there is nothing behind the dot at all.
        adminChapterReportCount: 0,
        adminMissingImageCount: 0,
        adminMissingDescriptionCount: 0,
        // Zeroed too, and for the plainest reason of the lot: these are things
        // that happened TO this account. NotificationFeed re-seeds it from the
        // next boot's bundle.
        notifCount: 0,
        // Zeroed too: a comparison is one account's shelf against one BGG
        // handle, and the next person signing in on this device shares
        // neither. BggSyncFlow.reset() drops the saved draft to match.
        bggSync: null,
        // Emptied for a milder reason: what an import created is a CATALOG
        // row, which is shared and survives. These jobs are only the record of
        // who asked for it, and the next account did not.
        bggImport: [],
      };
      for (const subs of this._subs.values()) {
        for (const fn of subs) {
          try { fn(null, null); } catch (_) {}
        }
      }
    }
  }

  window.Store = Store;
  window.store = new Store();
})();
