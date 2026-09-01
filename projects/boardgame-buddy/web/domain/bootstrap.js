// domain/bootstrap.js — first-paint cache warm-up.
//
// Calls GET /bootstrap once after auth, then seeds every cache namespace +
// the relevant store slots so the entire app navigates without paying
// further network calls until SWR background-refresh kicks in.
//
// The /bootstrap response shape (composed in bootstrap_routes.py + the
// bgb_bootstrap RPC):
//   {
//     bootstrap_version:    int,       // bump → FE wipes cache + rehydrates
//     generated_at:         timestamp,
//     current_user:         profile row,
//     profile_bundle:       bgb_profile_bundle output for self,
//     feed_first_page:      FeedPageResponse,
//     feed_cursor:          string|null,
//     recently_played_games: GameSummary[],  // host flow game-picker seed
//     play_partners:        { accounts, ghosts, recent },  // host player-picker seed
//   }
//
// The heavy per-owned-game detail bundles are NOT in here — building them is
// an N+1 in SQL and nothing on the first screen reads them, so they come from
// a second, deferred call (warmGameBundles → GET /bootstrap/game-bundles):
//   { game_detail_bundles: { gameId: bgb_game_detail_bundle output },
//     owned_count: int, truncated: bool }  // truncated = >max_bundles owned

(function () {
  // Bumped when the bootstrap RPC's shape changes. Mismatch with the server's
  // bootstrap_version forces a full cache wipe before rehydrating.
  // v2: game_detail_bundles moved out to /bootstrap/game-bundles.
  const EXPECTED_BOOTSTRAP_VERSION = 2;

  // TTL pairs (freshTtl, staleTtl) per namespace. Fresh = get() returns it,
  // no refresh. Stale = swr() returns it AND fires a background refresh.
  // hostSeed = 24h fresh / 7d stale — these lists only mutate on play
  // finalize or buddy graph edits, both of which invalidate explicitly.
  // feedFirst carries a long stale window on purpose: it's what lets a refresh
  // paint the last-seen feed immediately instead of sitting on a skeleton
  // while /bootstrap flies. Staleness after a write isn't governed by this —
  // Play's _invalidatePlayDeps() deletes the entry outright.
  // identity is the boot seed init.js reads before any await; it's rewritten on
  // every successful bootstrap, so a long TTL can't let it drift.
  const TTLS = {
    profile:     { fresh: 60 * 1000,        stale: 5 * 60 * 1000 },
    gameBundle:  { fresh: 30 * 60 * 1000,   stale: 60 * 60 * 1000 },
    feedFirst:   { fresh: 60 * 1000,        stale: 24 * 60 * 60 * 1000 },
    stats:       { fresh: 60 * 1000,        stale: 10 * 60 * 1000 },
    hostSeed:    { fresh: 24 * 60 * 60 * 1000, stale: 7 * 24 * 60 * 60 * 1000 },
    identity:    { fresh: 30 * 24 * 60 * 60 * 1000, stale: 30 * 24 * 60 * 60 * 1000 },
  };

  // Single-flight guards. Supabase can fire two auth callbacks at boot and both
  // reach for the profile; without these they'd each issue their own request.
  let _loadInflight = null;
  let _bundlesInflight = null;

  class Bootstrap {
    /**
     * Fetch /bootstrap and seed everything. Returns the raw response so the
     * caller (init.js) can react to it (e.g. set the user store slot).
     * On any error, rejects — init.js falls back to per-domain lazy fetches.
     */
    static load() {
      if (_loadInflight) return _loadInflight;
      _loadInflight = Bootstrap._load().finally(() => { _loadInflight = null; });
      return _loadInflight;
    }

    static async _load() {
      const payload = await window.api.get("/bootstrap");
      if (!payload || typeof payload !== "object") {
        throw new Error("bootstrap: empty payload");
      }

      // Server schema bump → wipe cache before seeding the new shape so we
      // don't mix old + new entries. clear() with no namespace drops both the
      // in-memory maps and this user's localStorage keys.
      if (payload.bootstrap_version !== EXPECTED_BOOTSTRAP_VERSION && window.bgbCache) {
        window.bgbCache.clear();
      }

      Bootstrap._seedCaches(payload);
      Bootstrap._seedStore(payload);
      return payload;
    }

    /**
     * Second-stage warm-up: the per-owned-game detail bundles. Split out of
     * /bootstrap because building them is an N+1 in SQL (one
     * bgb_game_detail_bundle per owned game, up to 250) and nothing on the
     * first screen reads them — Game Detail is the only consumer and it falls
     * back to its own fetch on a miss. init.js kicks this from an idle
     * callback once the user has landed.
     */
    static warmGameBundles() {
      if (_bundlesInflight) return _bundlesInflight;
      _bundlesInflight = Bootstrap._warmGameBundles()
        .finally(() => { _bundlesInflight = null; });
      return _bundlesInflight;
    }

    static async _warmGameBundles() {
      // This call is slow by construction (one bgb_game_detail_bundle per
      // owned game), so a mutation can easily land while it's in the air —
      // importing an expansion, for one. Stamp the start so the seed can skip
      // any game whose bundle was rewritten after the payload was built.
      const startedAt = Date.now();
      const payload = await window.api.get("/bootstrap/game-bundles");
      Bootstrap._seedGameBundles(payload && payload.game_detail_bundles, startedAt);
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
      // The profile bundle is what refreshes the last-play seed behind the
      // Play tab's "Another Round" card. It's a swr(), so this no-ops inside
      // the fresh window and only costs a request when it's actually stale.
      if (window.Profile && window.Profile.bundle) ps.push(window.Profile.bundle().catch(() => {}));
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
      const pbRecent = payload.profile_bundle
        && Array.isArray(payload.profile_bundle.recent_plays)
        ? payload.profile_bundle.recent_plays
        : null;

      // Profile bundle — keyed viewer|viewer per Profile.bundle() convention.
      if (viewerId && payload.profile_bundle) {
        cache.setWithTtls(
          "profile",
          viewerId + "|" + viewerId,
          payload.profile_bundle,
          { freshTtl: TTLS.profile.fresh, staleTtl: TTLS.profile.stale },
        );
      }

      // Pending buddy requests → the Profile tab's dot. Seeded here rather
      // than left to Profile._fetch(): the bundle above arrives inside
      // /bootstrap, so the first call that would have published it is one the
      // cache write we just made will legitimately skip.
      if (window.Buddy && window.Buddy.publishPendingFromBundle) {
        window.Buddy.publishPendingFromBundle(payload.profile_bundle);
      }
      // Same seed, same dot: incoming ghost claims (migration 070's
      // ghost_claims_incoming block).
      if (window.GhostClaim && window.GhostClaim.publishPendingFromBundle) {
        window.GhostClaim.publishPendingFromBundle(payload.profile_bundle);
      }

      // Identity seed. This is the one entry init.js reads synchronously right
      // after bindUser(), before any await — it's what lets the next boot paint
      // the user's screen without waiting on the network.
      if (viewerId && me) {
        cache.setWithTtls(
          "me",
          viewerId,
          me,
          { freshTtl: TTLS.identity.fresh, staleTtl: TTLS.identity.stale },
        );
      }

      // Normally empty now — the bundles arrive via warmGameBundles(). Still
      // honored here so a /bootstrap that does carry them (or a rollback to
      // the v1 payload) seeds correctly.
      Bootstrap._seedGameBundles(payload.game_detail_bundles);

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

      // Host flow seeds. The Gather screen's game picker reads game.recent;
      // the player picker reads buddy:all. Both render off cache on first
      // paint instead of paying for a network round-trip on every host tap.
      // Re-warmed after _finalizeSave() in play-flow-view.js.
      if (Array.isArray(payload.recently_played_games)) {
        cache.setWithTtls(
          "game.recent",
          "self",
          payload.recently_played_games,
          { freshTtl: TTLS.hostSeed.fresh, staleTtl: TTLS.hostSeed.stale },
        );
      }
      if (payload.play_partners) {
        cache.setWithTtls(
          "buddy",
          "all",
          payload.play_partners,
          { freshTtl: TTLS.hostSeed.fresh, staleTtl: TTLS.hostSeed.stale },
        );
      }

      // Last play → the Play tab's "Another Round" card. Its own long-lived
      // namespace rather than a read through profile_bundle, because that
      // bundle is DELETED after every save (Play.invalidateDeps) and expires
      // after 60s — so the card's sync peek used to miss on nearly every
      // visit and pop in after the network came back.
      if (pbRecent && window.Play && window.Play.rememberLastPlay) {
        window.Play.rememberLastPlay(pbRecent[0] || null);
      }

      // Collection: route through the existing seedFromBundle hook so the
      // module's _status / _expCount get primed without a /collection call.
      const pb = payload.profile_bundle;
      if (pb && pb.status_map && pb.expansion_counts &&
          window.Collection && window.Collection.seedFromBundle) {
        window.Collection.seedFromBundle(pb.status_map, pb.expansion_counts);
      }
    }

    /**
     * Seed the game.bundle namespace from a {gameId: bundle} map. Shared by
     * the bootstrap payload and the deferred /bootstrap/game-bundles warm-up
     * so both write the same TTLs.
     */
    static _seedGameBundles(bundles, fetchedAfter) {
      if (!window.bgbCache || !bundles) return;
      for (const gameId of Object.keys(bundles)) {
        const b = bundles[gameId];
        if (!b) continue;
        // A bundle written after this payload was requested is newer than
        // what we're holding — seeding over it would put the stale copy back.
        if (fetchedAfter && window.bgbCache.storedAt("game.bundle", gameId) > fetchedAfter) continue;
        window.bgbCache.setWithTtls(
          "game.bundle",
          gameId,
          b,
          { freshTtl: TTLS.gameBundle.fresh, staleTtl: TTLS.gameBundle.stale },
        );
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
