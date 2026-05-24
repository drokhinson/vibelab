// domain/bootstrap.js — first-paint cache warm-up.
//
// Calls GET /bootstrap once after auth, then seeds every cache namespace +
// the relevant store slots so the entire app navigates without paying
// further network calls until SWR background-refresh kicks in.
//
// The /bootstrap response shape (composed in bootstrap_routes.py + the
// bgb_bootstrap RPC):
//   {
//     bootstrap_version: int,       // bump → FE wipes cache + rehydrates
//     generated_at:      timestamp,
//     current_user:      profile row,
//     profile_bundle:    bgb_profile_bundle output for self,
//     game_detail_bundles: { gameId: bgb_game_detail_bundle output },
//     owned_count:       int,
//     truncated:         bool,      // true if >max_game_bundles owned
//     feed_first_page:   FeedPageResponse,
//     feed_cursor:       string|null,
//   }

(function () {
  // Bumped when the bootstrap RPC's shape changes. Mismatch with the server's
  // bootstrap_version forces a full cache wipe before rehydrating.
  const EXPECTED_BOOTSTRAP_VERSION = 1;

  // TTL pairs (freshTtl, staleTtl) per namespace. Fresh = get() returns it,
  // no refresh. Stale = swr() returns it AND fires a background refresh.
  const TTLS = {
    profile:     { fresh: 60 * 1000,        stale: 5 * 60 * 1000 },
    gameBundle:  { fresh: 30 * 60 * 1000,   stale: 60 * 60 * 1000 },
    feedFirst:   { fresh: 60 * 1000,        stale: 10 * 60 * 1000 },
    stats:       { fresh: 60 * 1000,        stale: 10 * 60 * 1000 },
  };

  class Bootstrap {
    /**
     * Fetch /bootstrap and seed everything. Returns the raw response so the
     * caller (init.js) can react to it (e.g. set the user store slot).
     * On any error, rejects — init.js falls back to per-domain lazy fetches.
     */
    static async load() {
      const payload = await window.api.get("/bootstrap");
      if (!payload || typeof payload !== "object") {
        throw new Error("bootstrap: empty payload");
      }

      // Server schema bump → wipe cache before seeding the new shape so we
      // don't mix old + new entries.
      if (payload.bootstrap_version !== EXPECTED_BOOTSTRAP_VERSION) {
        const me = payload.current_user;
        if (window.bgbCache && me && me.id) {
          window.bgbCache.unbindUser();
          window.bgbCache.bindUser(me.id);
        }
      }

      Bootstrap._seedCaches(payload);
      Bootstrap._seedStore(payload);
      return payload;
    }

    /**
     * Targeted refresh after a tab-focus / pull-to-refresh. Only hits the
     * blocks most likely to have changed since the last fetch — leaves the
     * heavy game_detail_bundles alone (they're versioned via game.bundle TTL
     * and almost never change in-session).
     */
    static async warmRefresh() {
      // Feed first page + stats. swr() naturally no-ops if both are still
      // inside their fresh window, so this is cheap to call on every focus.
      const me = window.store.get("user");
      const ps = [];
      if (window.Feed && window.Feed.refreshFirstPage) ps.push(window.Feed.refreshFirstPage());
      if (me && window.Stats && window.Stats.for) ps.push(window.Stats.for(me.id).catch(() => {}));
      if (window.Collection && window.Collection.myStatusMap) {
        ps.push(window.Collection.myStatusMap().catch(() => {}));
      }
      await Promise.all(ps);
    }

    static _seedCaches(payload) {
      if (!window.bgbCache) return;
      const cache = window.bgbCache;
      const me = payload.current_user;
      const viewerId = me && me.id;

      // Profile bundle — keyed viewer|viewer per Profile.bundle() convention.
      if (viewerId && payload.profile_bundle) {
        cache.setWithTtls(
          "profile",
          viewerId + "|" + viewerId,
          payload.profile_bundle,
          { freshTtl: TTLS.profile.fresh, staleTtl: TTLS.profile.stale },
        );
      }

      // Every owned game's full detail bundle. Opening any of these in
      // Game Detail is now instant.
      const bundles = payload.game_detail_bundles || {};
      for (const gameId of Object.keys(bundles)) {
        const b = bundles[gameId];
        if (!b) continue;
        cache.setWithTtls(
          "game.bundle",
          gameId,
          b,
          { freshTtl: TTLS.gameBundle.fresh, staleTtl: TTLS.gameBundle.stale },
        );
      }

      // Stats — pulled from profile_bundle.stats so we don't pay a separate
      // /users/me/stats round trip on Profile mount.
      const stats = payload.profile_bundle && payload.profile_bundle.stats;
      if (viewerId && stats) {
        cache.setWithTtls(
          "stats",
          viewerId,
          stats,
          { freshTtl: TTLS.stats.fresh, staleTtl: TTLS.stats.stale },
        );
      }

      // Feed first page — keyed 'first' to match Feed.fetchPage()'s convention
      // once that file converts to SWR (Phase 4).
      if (payload.feed_first_page) {
        cache.setWithTtls(
          "feed",
          "first",
          payload.feed_first_page,
          { freshTtl: TTLS.feedFirst.fresh, staleTtl: TTLS.feedFirst.stale },
        );
      }

      // Collection: route through the existing seedFromBundle hook so the
      // module's _status / _expCount get primed without a /collection call.
      const pb = payload.profile_bundle;
      if (pb && pb.status_map && pb.expansion_counts &&
          window.Collection && window.Collection.seedFromBundle) {
        window.Collection.seedFromBundle(pb.status_map, pb.expansion_counts);
      }
    }

    static _seedStore(payload) {
      if (!window.store) return;
      const me = payload.current_user;
      if (me && window.User) {
        // Mirror User.current()'s shape so subscribers see a User instance,
        // not a raw row — header avatar render depends on this.
        window.store.set("user", new window.User(me));
      }
      if (payload.feed_first_page) {
        window.store.set("feed", payload.feed_first_page);
        window.store.set("feedCursor", payload.feed_cursor || null);
      }
    }
  }

  window.Bootstrap = Bootstrap;
})();
