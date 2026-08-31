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
  }

  // Note: the `play.last` seed is deliberately NOT cleared here. This also runs
  // for create / finalize / attachPhoto, which are exactly the moments the
  // Another Round card should be showing the play that just landed — the
  // caller (play-flow's _runSave) writes the fresh row into the seed. The
  // mutations that can genuinely destroy or reshape the top play (update,
  // remove, leave) clear it themselves.
  function _invalidatePlayDeps() {
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
