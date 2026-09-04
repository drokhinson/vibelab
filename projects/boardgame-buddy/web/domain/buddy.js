// domain/buddy.js — Mutual friend graph.

(function () {
  const CACHE_NS = "buddy";
  const ALL_KEY = "all";
  // 24h fresh / 7d stale: the combined buddies/ghosts/recent bundle only
  // mutates when the user finalizes a play (new ghost names, bumped
  // played-with counts) or edits the friend graph (accept / unfriend /
  // link / merge ghost). Each of those mutation sites calls
  // Buddy.invalidate(), so the cache is the source of truth between them.
  const FRESH_TTL_MS = 24 * 60 * 60 * 1000;
  const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // The one-shot first-run suggestion prefetch — see prefetchOnboarding below.
  let _onboardingPrefetch = null;

  // Private aliases this SESSION has set, userId → alias|null. Written
  // synchronously by setAlias() before the refetch it triggers has landed, and
  // it deliberately outlives invalidate(): allBuddies() is SWR'd 24h/7d, so
  // between "the user renamed Dave" and "a fresh bundle arrives" there is a
  // window where the cache still says the old thing — and on a flaky
  // connection that window is the whole session. A map of what we ourselves
  // just wrote is the only thing that closes it.
  //
  // Not a store slot: nothing subscribes to it, every consumer reads it inside
  // its own render pass, and a slot would be a second thing to keep in step
  // with the cache.
  /** @type {Map<string, string|null>} */
  const _aliasEdits = new Map();

  // userId → edge id, for the surfaces that hold a user id and nothing else.
  // Seeded from the same payloads as the aliases; its ABSENCE is the test for
  // "this person can't be aliased" (a ghost seat, or an account the viewer
  // isn't buddies with), which is what keeps the pencil off rows whose save
  // would 404.
  /** @type {Map<string, string>} */
  const _edgeIds = new Map();

  class Buddy {
    constructor(raw) { Object.assign(this, raw || {}); }

    static list() { return window.api.get("/buddies"); }

    static requests() { return window.api.get("/buddies/requests"); }

    static sendRequest(targetUserId) {
      return window.api.post("/buddies/request", { target_user_id: targetUserId });
    }

    static accept(requestId)  { return window.api.post(`/buddies/${requestId}/accept`, {}); }
    static reject(requestId)  { return window.api.post(`/buddies/${requestId}/reject`, {}); }
    // Withdraw a request WE sent. Distinct from reject(), which is the
    // recipient's decline — same edge, opposite party, different meaning to
    // whoever is on the other end.
    static cancel(requestId)  { return window.api.post(`/buddies/${requestId}/cancel`, {}); }
    static unfriend(edgeId)   { return window.api.del(`/buddies/${edgeId}`); }

    // Profile search — returns ProfileSearchResult[]
    static searchProfiles(q) { return window.api.get("/profiles/search", { q }); }

    // Add by QR. The token is short-lived and stateless (see the backend's
    // buddy_qr_service) — never cache it and never persist it, because a
    // stored copy outlives the consent it stands for.
    static qrToken() { return window.api.post("/buddies/qr-token", {}); }

    // Resolve a scanned token to the person who minted it, WITHOUT adding
    // them — the scan screen shows who it is and lets the user choose. Same
    // token, same verification, no write. Resolves
    // { user_id, display_name, username, avatar, relation }.
    static peekQr(token) { return window.api.post("/buddies/qr-peek", { token }); }

    // Redeem a scanned token: both users become buddies immediately, no
    // pending request. 410 = expired or forged, 400 = your own code,
    // 403 = blocked, 404 = the account is gone. Called with the same token
    // peekQr() just resolved, so the code is read once and used twice.
    static addByQr(token) { return window.api.post("/buddies/qr-add", { token }); }

    // "Buddies you may know" — the same ranked candidates the Feed rail
    // renders, as a standalone call so the Buddies screen doesn't have to
    // pull a feed page for them. Uncached: the RPC already excludes anyone
    // the viewer shares an edge with, so a stale copy would offer an Add
    // button for a request that's already sent.
    static suggested() { return window.api.get("/buddies/suggested"); }

    // The onboarding "Add buddies" step's list. A separate endpoint, not
    // suggested() with a bigger limit: that one only returns people the
    // viewer already shares a play or a buddy with, which is empty for the
    // account that was created ninety seconds ago — see migration 063. Each
    // candidate carries a `source` saying which tier it came from.
    static onboardingSuggestions(limit) {
      return window.api.get("/buddies/suggested/onboarding", limit ? { limit } : {});
    }

    // First-run's suggestions, asked for the moment we learn the account needs
    // setting up — while the user is still on the deck's first slide naming
    // themselves. By the time slide 2 arrives the grid usually paints from
    // this instead of opening on a spinner.
    //
    // A single-slot, consume-once channel rather than a cache entry, in the
    // shape of PlaySession.prefetchLobby: the payload is for exactly one
    // screen in one session, and the reasons suggested()/onboardingSuggestions()
    // are uncached (a stale copy offers Add for a request already sent) apply
    // just as hard to a second reader of this one.
    static prefetchOnboarding(limit) {
      if (_onboardingPrefetch) return _onboardingPrefetch;
      // Swallowed here so an unconsumed rejection never reaches the console as
      // an unhandled promise; the consumer sees the rejection it awaits.
      _onboardingPrefetch = Buddy.onboardingSuggestions(limit || 12);
      _onboardingPrefetch.catch(() => {});
      return _onboardingPrefetch;
    }

    /** The prefetched promise, if one is parked. Clears the slot. */
    static takePrefetchedOnboarding() {
      const p = _onboardingPrefetch;
      _onboardingPrefetch = null;
      return p;
    }

    // Multi-select send. Resolves { sent: string[], sent_count, failed:
    // [{user_id, detail}] } — a partial batch is the expected shape, not an
    // error, so callers report counts rather than branching on a throw.
    static sendRequests(targetUserIds) {
      return window.api.post("/buddies/requests/bulk", { target_user_ids: targetUserIds });
    }

    // Played-with discovery + ghost-player linking.
    static playedWith()   { return window.api.get("/played-with"); }
    static ghostPlayers() { return window.api.get("/ghost-players"); }
    static linkGhost(displayName, targetUserId) {
      return window.api.post("/ghost-players/link", {
        display_name: displayName,
        target_user_id: targetUserId,
      });
    }
    static mergeGhosts(sourceDisplayName, targetDisplayName) {
      return window.api.post("/ghost-players/merge", {
        source_display_name: sourceDisplayName,
        target_display_name: targetDisplayName,
      });
    }

    // ── Private aliases ─────────────────────────────────────────────────────
    // A private alias is a name the VIEWER gave one of their buddies, stored on
    // their own side of the buddy edge and never shown to the person it names.
    //
    // It rides the payload on the two calls that already join the edge
    // (/buddies and /play-partners → accounts[]); everywhere else it is applied
    // at render time through nameFor() below. That split is deliberate: the
    // plays and feed RPCs are keyed by the person whose log is being read, not
    // by the viewer, so an alias joined server-side there would be the wrong
    // person's — and baking a private string into shared, localStorage-backed
    // cache entries gives it an invalidation story nobody is maintaining.

    /**
     * Fold the aliases (and edge ids) off a /buddies or /play-partners payload
     * into the session maps. Any surface that fetches edges directly calls
     * this, so a screen that never touched the partner bundle still renders
     * aliases.
     * @param {any[]} edges Buddy edge rows (other_user_id / other_alias / id).
     */
    static rememberAliases(edges) {
      for (const e of (edges || [])) {
        if (!e || !e.other_user_id) continue;
        _aliasEdits.set(e.other_user_id, e.other_alias || null);
        if (e.id) _edgeIds.set(e.other_user_id, e.id);
      }
    }

    /**
     * The viewer's private alias for one user, or null. The ONE reader of the
     * alias sources — no view builds its own map.
     *
     * Session edits win over the cached bundle, which is read through peek()
     * so it serves out to staleTtl like every other "paint from what bootstrap
     * warmed" read in the views.
     * @param {string|null|undefined} userId
     * @returns {string|null}
     */
    static aliasFor(userId) {
      if (!userId) return null;
      if (_aliasEdits.has(userId)) return _aliasEdits.get(userId) || null;
      const hit = Buddy._accountFor(userId);
      return (hit && hit.other_alias) || null;
    }

    /**
     * The buddy edge id for a user, or null when they are not an accepted
     * buddy. Callers use the null to decide whether to offer the alias control
     * at all — a ghost player and a played-with stranger both land here.
     * @param {string|null|undefined} userId
     * @returns {string|null}
     */
    static edgeIdFor(userId) {
      if (!userId) return null;
      if (_edgeIds.has(userId)) return _edgeIds.get(userId) || null;
      const hit = Buddy._accountFor(userId);
      return (hit && hit.id) || null;
    }

    /**
     * What a person should READ AS wherever one name is shown: the alias when
     * there is one, otherwise whatever the payload called them. Every surface
     * outside the Buddies list goes through this and nothing else, so "where
     * can an alias appear" has exactly one answer.
     *
     * A null userId returns realName verbatim — a ghost has no account to
     * alias. It never returns the alias in place of a name that will be
     * WRITTEN: see the player picker and the play-detail popup, both of which
     * keep the real name as the value and use this only to paint.
     * @param {string|null|undefined} userId
     * @param {string|null|undefined} realName
     * @returns {string}
     */
    static nameFor(userId, realName) {
      return Buddy.aliasFor(userId) || realName || "";
    }

    /** The cached partner bundle's account row for a user, or null. */
    static _accountFor(userId) {
      const bundle = window.bgbCache && window.bgbCache.peek(CACHE_NS, ALL_KEY);
      return ((bundle && bundle.accounts) || [])
        .find((b) => b && b.other_user_id === userId) || null;
    }

    /**
     * Set or clear the alias, then make the answer true everywhere at once: the
     * session map first (synchronous, so the very next paint is right) and the
     * SWR bundle dropped second, so the next allBuddies() refetches instead of
     * serving a still-fresh copy that names them the old way.
     * @param {string} edgeId
     * @param {string|null} alias Blank or null clears it.
     * @returns {Promise<any>} the updated buddy edge
     */
    static async setAlias(edgeId, alias) {
      const edge = await window.api.post(`/buddies/${edgeId}/alias`, {
        alias: (alias || "").trim() || null,
      });
      if (edge && edge.other_user_id) {
        _aliasEdits.set(edge.other_user_id, edge.other_alias || null);
        _edgeIds.set(edge.other_user_id, edge.id || edgeId);
      }
      Buddy.invalidate();
      return edge;
    }

    /**
     * Drop every remembered alias. Called on sign-out: the maps are keyed by
     * user id, so without this the next account to sign in on this device would
     * paint the previous one's private names over their own buddies.
     */
    static forgetAliases() {
      _aliasEdits.clear();
      _edgeIds.clear();
    }

    // Combined preload for the gather-player picker. Accounts (accepted buddy
    // edges), ghosts (free-text players the user has logged before), and
    // recent played-with (real accounts ordered by shared-play count) in one
    // call — GET /play-partners is a single bgb_play_partners RPC. This used
    // to be three parallel requests, each paying its own auth lookup and its
    // own query fan-out. SWR-cached at FRESH_TTL_MS / STALE_TTL_MS above
    // (24h / 7d), so the picker dropdown opens with zero round-trips after the
    // first hit.
    static allBuddies() {
      return window.bgbCache.swr(
        CACHE_NS,
        ALL_KEY,
        async () => {
          let data;
          try {
            data = await window.api.get("/play-partners");
          } catch (_) {
            data = null;
          }
          const accounts = (data && data.accounts) || [];
          // Seed the alias / edge-id maps off the same payload the picker
          // paints from, so every surface agrees without a second request.
          Buddy.rememberAliases(accounts);
          return {
            accounts,
            ghosts: (data && data.ghosts) || [],
            recent: (data && data.recent) || [],
          };
        },
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS },
      );
    }

    /**
     * The partner bundle as PLAYER PICKER CANDIDATES — one shape, one place.
     *
     * Worth its own function because the bundle speaks three dialects and the
     * picker speaks one. `accounts` are buddy EDGES, so a buddy's name is
     * `other_display_name` and their id is `other_user_id` — `id` is the edge's
     * own id. Reading them as if they were profiles is not a shape mismatch
     * that shows up as a wrong name: it produces a nameless row that the
     * picker's own `name` filter then drops, so the whole buddy list silently
     * vanishes and only ghosts remain. That is exactly what the play importer
     * shipped, which is why this mapping now lives here rather than at each
     * call site.
     *
     * The viewer is NOT included — the RPC never returns them, and the one
     * caller that wants them at the table (the importer) prepends its own row
     * marked `isViewer`.
     *
     * @param {{accounts?: any[], ghosts?: any[], recent?: any[]}|null} partners
     * @returns {Array<{source: "account"|"ghost", user_id: string|null,
     *   name: string, alias?: string|null, username: string|null, avatar: any,
     *   plays?: number}>}
     */
    static toPlayerCandidates(partners) {
      const p = partners || {};
      /** @type {any[]} */
      const out = [];
      const seenIds = new Set();

      // Plays together, so a buddy row can say why it's worth picking. Comes
      // off `recent`, which is the only list that counts them.
      /** @type {Object<string, number>} */
      const together = {};
      for (const r of (p.recent || [])) {
        if (r && r.user_id) together[r.user_id] = r.play_count || 0;
      }

      for (const b of (p.accounts || [])) {
        if (!b) continue;
        const userId = b.other_user_id || b.user_id || null;
        const name = b.other_display_name || b.display_name || b.other_username || b.username || "";
        if (!userId || !name || seenIds.has(userId)) continue;
        seenIds.add(userId);
        out.push({
          source: "account",
          user_id: userId,
          // `name` is the REAL display name, always. It is what the picker
          // hands back and what play_players.player_display_name ends up
          // storing (play-flow-view#_addPlayers → play_routes), a row every
          // participant can read — a private alias must never land there.
          // `alias` is the render-time overlay; the picker paints it and
          // searches both.
          name,
          alias: Buddy.aliasFor(userId),
          username: b.other_username || b.username || null,
          avatar: b.other_avatar || b.avatar || null,
          plays: together[userId] || 0,
        });
      }

      // People the viewer has shared a table with but never added. They are
      // already in this user's plays, so they are the likeliest answer to
      // "who is this name?" after the buddies themselves — and leaving them
      // out would make an imported play land on a NEW ghost beside the account
      // that already holds the rest of that person's history.
      for (const r of (p.recent || [])) {
        if (!r || !r.user_id || seenIds.has(r.user_id) || !r.display_name) continue;
        seenIds.add(r.user_id);
        out.push({
          source: "account",
          user_id: r.user_id,
          name: r.display_name,
          // A `recent` row that survives the dedupe above is by definition NOT
          // a buddy (every accepted edge is in `accounts`), so there is no edge
          // to hold an alias — but ask anyway rather than hard-coding null, so
          // this stays right if the dedupe order ever changes.
          alias: Buddy.aliasFor(r.user_id),
          username: r.username || null,
          avatar: r.avatar || null,
          plays: r.play_count || 0,
        });
      }

      for (const g of (p.ghosts || [])) {
        if (!g) continue;
        const name = g.display_name || g.name || "";
        if (!name) continue;
        out.push({
          source: "ghost",
          user_id: null,
          name,
          username: null,
          avatar: null,
          plays: g.play_count || 0,
        });
      }
      return out;
    }

    // ── Pending incoming requests ───────────────────────────────────────────
    // Two surfaces read this: the Profile nav tab's dot (shared with unseen
    // achievements — see domain/achievements.js#publishUnseen) and the red
    // count in the corner of the hub's Buddies card. It lives in the store
    // (slot `buddyRequestCount`) because neither surface is mounted when the
    // other needs it — the nav bar outlives every view, and the hub is not on
    // screen when a request lands while the user is on the Feed.
    //
    // Two writers, in order of freshness: the profile bundle (which carries
    // buddy_requests_incoming, and is refreshed by /bootstrap, the hub, and
    // every tab-focus warmRefresh), and the Buddies screen, whose accept /
    // decline handlers know the new count a round trip before the server does.
    static pendingCount() { return window.store.get("buddyRequestCount") || 0; }

    static setPendingCount(n) {
      window.store.set("buddyRequestCount", Math.max(0, Math.floor(Number(n) || 0)));
    }

    /**
     * Publish the count off a bgb_profile_bundle payload. No-ops when the
     * block is absent — the RPC omits requests entirely on someone else's
     * profile, and an absent list is "not my business", not "zero waiting".
     */
    static publishPendingFromBundle(bundle) {
      if (!bundle || !Array.isArray(bundle.buddy_requests_incoming)) return;
      Buddy.setPendingCount(bundle.buddy_requests_incoming.length);
    }

    // Drop the combined cache so the next allBuddies() refetches. Call after
    // mutations that would change the roster: accept/unfriend, save a play
    // (which may add new ghost names or bump play counts).
    static invalidate() {
      if (window.bgbCache) window.bgbCache.clear(CACHE_NS);
      // Buddy System turns on the first accepted edge.
      if (window.Achievements && window.Achievements.invalidate) window.Achievements.invalidate();
    }
  }

  window.Buddy = Buddy;
})();
