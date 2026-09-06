// domain/play.js — Logged play.
//
// Also owns the "last play" seed (cache ns `play.last`, key `self`): the most
// recent play row the viewer took part in, kept on a host-seed TTL so the Play
// tab's "Another Round" card can render synchronously on first paint. It lives
// here rather than in the profile bundle because _invalidatePlayDeps() DELETES
// that bundle after every save — precisely the moment the card matters most.

(function () {
  const LAST_NS = "play.last";
  const LAST_KEY = "self";
  // Mirrors bootstrap's hostSeed pair: 24h fresh / 7d stale. The seed is
  // rewritten on every save and on every profile-bundle fetch, so a long
  // window can't let it drift — it only has to outlive the app being closed.
  const LAST_FRESH_TTL_MS = 24 * 60 * 60 * 1000;
  const LAST_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Paged /plays reads. This was the only domain call with no cache wrapper at
  // all, so every Plays mount, every debounced search keystroke and every
  // return visit re-fetched pages the client had already seen — backspacing
  // through a search re-issued queries that were already answered.
  // play_id -> a PlayResponse-shaped object projected from a feed card. Module
  // scope, not bgbCache: it holds no TTL, is never persisted, and never answers
  // a fetch — see the note on the seed methods below.
  const _seeds = new Map();

  const LIST_NS = "play.list";
  const LIST_FRESH_TTL_MS = 60 * 1000;
  const LIST_STALE_TTL_MS = 5 * 60 * 1000;

  function _listKey({ gameId, buddyId, search, userId, page, perPage }) {
    return [userId || "me", gameId || "", buddyId || "", search || "", page, perPage].join("|");
  }

  class Play {
    constructor(raw) { Object.assign(this, raw || {}); }

    static list(opts = {}) {
      const { gameId, buddyId, search, userId, page = 1, perPage = 20 } = opts;
      const key = _listKey({ gameId, buddyId, search, userId, page, perPage });
      return window.bgbCache.swr(
        LIST_NS,
        key,
        () => window.api.get("/plays", {
          game_id: gameId,
          buddy_id: buddyId,
          user_id: userId || undefined,
          search: search || undefined,
          page,
          per_page: perPage,
        }),
        { freshTtl: LIST_FRESH_TTL_MS, staleTtl: LIST_STALE_TTL_MS },
      );
    }

    /**
     * Synchronous stale-tolerant peek at a cached page, so the Plays spoke can
     * paint in its first frame instead of awaiting. peek(), not get(): a page a
     * couple of minutes old beats a spinner, and list() is what corrects it.
     */
    static cachedList(opts = {}) {
      if (!window.bgbCache) return null;
      const { gameId, buddyId, search, userId, page = 1, perPage = 20 } = opts;
      return window.bgbCache.peek(
        LIST_NS,
        _listKey({ gameId, buddyId, search, userId, page, perPage }),
      );
    }

    static get(id) { return window.api.get(`/plays/${id}`); }

    // ── Seeds from the feed (migration 015) ────────────────────────────────
    //
    // The feed card now carries the whole play — the full roster with scores
    // and round_scores, the expansions, the country. That is everything the
    // card's BACK and the detail popup render, so both can paint from a card
    // the client already has instead of each calling GET /plays/{id} on open.
    // Before this, flipping a card showed "Loading play…" for a network hop,
    // and flipping then maximising fetched the same row twice, because the
    // card and the popup keep separate state and Play.get is the one domain
    // read with no cache wrapper.
    //
    // A seed is deliberately NOT a cache with a TTL. It is a projection of a
    // feed page the user is looking at right now, it never satisfies a fetch
    // on its own, and the surfaces that read it are all re-rendered from the
    // feed whenever the feed refreshes. Anything that could make it wrong —
    // an edit, a delete, a leave — drops it explicitly below.

    /**
     * A feed card, reshaped into the PlayResponse the back face and the popup
     * expect. Only the names differ between the two shapes; nothing is derived
     * except `is_own`, which the card implies via its logger rather than
     * carrying as a field of its own.
     * @param {any} card a feed play card
     * @returns {any} PlayResponse-shaped
     */
    static fromFeedCard(card) {
      const g = card.game || {};
      const me = window.store && window.store.get && window.store.get("user");
      const logger = card.user || null;
      return {
        id: card.play_id,
        game_id: g.id || null,
        game_name: g.name || "",
        game_thumbnail: g.thumbnail_url || g.image_url || null,
        played_at: card.played_at,
        created_at: card.created_at,
        notes: card.notes == null ? null : card.notes,
        photo_url: card.photo_url == null ? null : card.photo_url,
        play_mode: card.play_mode || "competitive",
        country_code: card.country_code == null ? null : card.country_code,
        players: card.players || [],
        expansions: card.expansions || [],
        logged_by_id: logger ? logger.id : null,
        logged_by_name: logger ? logger.display_name : null,
        is_own: !!(me && me.id && logger && logger.id === me.id),
        group_count: card.group_count || 1,
      };
    }

    /**
     * Remember a card's play, if the card is carrying one. Called from the
     * canonical play-card render, so every surface that draws a card seeds by
     * construction and no view has to remember to.
     *
     * An empty `players` means the RPC predates 015 — the seed is skipped and
     * every consumer falls back to fetching, exactly as before.
     */
    static seedFromFeedCard(card) {
      if (!card || !card.play_id) return null;
      if (!Array.isArray(card.players) || card.players.length === 0) return null;
      const play = Play.fromFeedCard(card);
      _seeds.set(card.play_id, play);
      return play;
    }

    /** The remembered play, or null. Synchronous — this is its whole point. */
    static seeded(id) { return _seeds.get(id) || null; }

    // Any play mutation can shift Profile stats, recent_plays, and the
    // played-not-owned shelf; it can also change Game Detail's recent_plays
    // for that game. Bust the bundle caches so the next visit re-hydrates.
    static create(payload) {
      return window.api.post("/plays", payload).then((r) => { _invalidatePlayDeps(); return r; });
    }
    static update(id, payload) {
      return window.api.put(`/plays/${id}`, payload).then((r) => {
        _invalidatePlayDeps();
        Play.rememberLastPlay(null);
        return r;
      });
    }
    // Write just the photo column. PUT /plays/{id} is a FULL replacement —
    // it deletes and re-inserts every player and expansion row — so routing
    // a photo attach through it cost twelve round trips and churned rows
    // that hadn't changed. This is one.
    static attachPhoto(id, photoUrl) {
      return window.api.patch(`/plays/${id}/photo`, { photo_url: photoUrl })
        .then((r) => { _invalidatePlayDeps(); return r; });
    }
    static remove(id) {
      return window.api.del(`/plays/${id}`).then((r) => {
        _invalidatePlayDeps();
        Play.rememberLastPlay(null);
        return r;
      });
    }
    // Self-remove from a play you didn't take part in. The backend turns your
    // player row into a ghost (keeps the play for its owner) rather than
    // deleting it. Busts the same caches as any other play mutation so your
    // history/stats drop it on next read.
    static leave(id) {
      return window.api.post(`/plays/${id}/leave`, {}).then((r) => {
        _invalidatePlayDeps();
        Play.rememberLastPlay(null);
        return r;
      });
    }

    /**
     * Remember the viewer's most recent play. `row` is a PlayResponse (or a
     * profile bundle `recent_plays[0]`) — the two shapes agree on everything
     * the Another Round card and PlaySession.seedFromPlayRow() read. Passing
     * null clears the seed (the viewer has no plays left).
     */
    static rememberLastPlay(row) {
      if (!window.bgbCache) return;
      if (!row || !row.game_id) {
        window.bgbCache.delete(LAST_NS, LAST_KEY);
        return;
      }
      window.bgbCache.setWithTtls(LAST_NS, LAST_KEY, row, {
        freshTtl: LAST_FRESH_TTL_MS,
        staleTtl: LAST_STALE_TTL_MS,
      });
    }

    /** Synchronous read of the seed above, or null. Never hits the network. */
    static cachedLastPlay() {
      if (!window.bgbCache) return null;
      return window.bgbCache.peek(LAST_NS, LAST_KEY);
    }

    // Public handle on the same invalidation the mutations above run. Exists
    // for writes that create a play without going through this class —
    // PlaySession.finalizeLobby() posts to /sessions/{code}/finalize, which is
    // a play create in everything but the URL and left every one of these
    // caches stale.
    static invalidateDeps() { _invalidatePlayDeps(); }

    // ── Imported plays (migrations 005/007) ─────────────────────────────────
    // Two units, because they answer two different regrets: one run of
    // identical plays read wrong, versus a whole paste that should never have
    // happened. Both are owner-scoped server-side and report what they removed.

    /** Delete one run of identical imported plays. @returns {Promise<{deleted:number}>} */
    static deleteImportGroup(groupId) {
      return window.api.del(`/plays/import-group/${encodeURIComponent(groupId)}`)
        .then((r) => { _invalidatePlayDeps(); return r; });
    }

    /** Delete everything one import wrote. @returns {Promise<{deleted:number}>} */
    static deleteImportBatch(batchId) {
      return window.api.del(`/plays/import-batch/${encodeURIComponent(batchId)}`)
        .then((r) => { _invalidatePlayDeps(); return r; });
    }

    /** Past imports, newest first — the Settings list. */
    static listImports() {
      return window.api.get("/plays/imports").then((r) => (r && r.imports) || []);
    }
  }

  // Note: the `play.last` seed is deliberately NOT cleared here. This also runs
  // for create / finalize / attachPhoto, which are exactly the moments the
  // Another Round card should be showing the play that just landed — the
  // caller (play-flow's _runSave) writes the fresh row into the seed. The
  // mutations that can genuinely destroy or reshape the top play (update,
  // remove, leave) clear it themselves.
  function _invalidatePlayDeps() {
    // Every seed, not the one that changed: this also fires for the bulk
    // import-group and import-batch deletes, which drop many plays at once and
    // whose ids the caller never enumerates. Clearing wholesale is free — the
    // feed cache is dropped a few lines below, so the next feed paint reseeds
    // from fresh rows anyway — and it cannot miss a mutation path.
    _seeds.clear();
    if (window.Profile && window.Profile.invalidate) window.Profile.invalidate();
    if (window.Game && window.Game.invalidateBundle) window.Game.invalidateBundle();
    // Four badges move on a play: plays logged, wins, the biggest table you
    // have sat at, and whether you wrote the night down.
    if (window.Achievements && window.Achievements.invalidate) window.Achievements.invalidate();
    // Stats live in their own cache namespace now — clear so the next
    // Profile mount re-pulls accurate plays/wins counts.
    if (window.Stats && window.Stats.invalidate) window.Stats.invalidate();
    // Drop the cached feed first page; the next Feed mount triggers a fresh
    // fetch. Callers that want the new page warm before the user gets there
    // (the host save flow) follow up with Feed.refreshFirstPage().
    if (window.bgbCache) window.bgbCache.delete("feed", "first");
    // Every cached /plays page can contain the row that just changed, and the
    // paging is offset-based, so a single insert shifts every page after it.
    // Namespace-wide is the only correct scope.
    if (window.bgbCache) window.bgbCache.clear(LIST_NS);
    // last_played_at / play_count are the collection shelf's sort key.
    if (window.Collection && window.Collection.invalidateShelves) {
      window.Collection.invalidateShelves();
    }
    if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
    window.store.invalidate("feed");
  }

  window.Play = Play;
})();
