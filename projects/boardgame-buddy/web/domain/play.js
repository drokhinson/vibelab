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

  // Where a play sits in a list of play rows, or -1.
  //
  // A run row is deliberately never matched: it stands for a whole group of
  // identical imported plays (migration 005), swapping it for the one play
  // that was edited would drop the other 57, and removing it would drop them
  // all. It is not openable from any list either, so a mutation cannot have
  // come from one.
  function _rowIndex(rows, playId) {
    return rows.findIndex((p) => p && p.id === playId && (p.group_count || 1) === 1);
  }

  // The order every plays query returns: `played_at DESC, created_at DESC`.
  // played_at is editable and is the primary key of that sort, so a patched
  // list has to be re-sorted or a play nudged back a day sits above rows it
  // now belongs below. created_at breaks the tie the same way the SQL does —
  // several plays on one date is the normal case, not an edge one.
  function _sortRows(rows) {
    rows.sort((a, b) =>
      String(b.played_at || "").localeCompare(String(a.played_at || ""))
      || String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows;
  }

  /**
   * A play projected out of a cached /plays page, or null.
   *
   * `bgb_plays_page` (migration 018) returns the whole PlayResponse per row —
   * the full roster with round_scores, and the scoring_template — so a page the
   * client already holds can seed the detail popup just as a feed card does.
   *
   * Three gates, and each one is load-bearing:
   *
   * 1. `group_count === 1`. A run row stands for many identical imported plays;
   *    the same rule keeps applyToCachedLists from swapping one for 58.
   * 2. The row must actually carry `scoring_template` AND a roster. This is why
   *    the fallback lives here rather than at the call sites: plays-view falls
   *    back to the profile bundle's `recent_plays` (003_rpcs.sql), whose players
   *    carry no round_scores and which has no template at all, and preview-card
   *    renders from the same rows. Seeding off those would recreate the exact
   *    bug this fallback exists to fix, from a second source.
   * 3. `is_own` is RECOMPUTED. bgb_plays_page computes it as
   *    `pg.user_id = p_target` — relative to whose log you are browsing, not to
   *    the viewer — so a buddy's play read off their own log claims is_own and
   *    the popup would flash Edit and Delete before the fetch took them away.
   *
   * @param {string} id a play id
   * @returns {any} a PlayResponse-shaped object, or null
   */
  function _seedFromCachedLists(id) {
    if (!window.bgbCache) return null;
    for (const key of window.bgbCache.keys(LIST_NS)) {
      const page = window.bgbCache.peek(LIST_NS, key);
      if (!page || !Array.isArray(page.plays)) continue;
      const row = page.plays.find((p) => p && p.id === id && (p.group_count || 1) === 1);
      if (!row) continue;
      if (!("scoring_template" in row)) continue;
      if (!Array.isArray(row.players) || row.players.length === 0) continue;
      const me = window.store && window.store.get && window.store.get("user");
      return Object.assign({}, row, {
        is_own: !!(me && me.id && row.logged_by_id && row.logged_by_id === me.id),
      });
    }
    return null;
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

    /**
     * A roster in a deterministic TOTAL order, for painting a scoreboard.
     *
     * The three payloads a play can arrive in disagree about row order, and two
     * of them have no order at all: the feed RPC sorts
     * (is_winner DESC, score DESC NULLS LAST, migration 031), while
     * `bgb_plays_page` and the REST `_fetch_players` both hand back whatever
     * Postgres felt like. A sort keyed only on `score` is *stable*, so it
     * preserves whichever arrival order it was given — which means the same
     * play painted from a seed and then from the confirming fetch renders its
     * players in two different orders, and the surface repaints for no reason.
     * Every co-op play (all scores null) and every tie hits this.
     *
     * `score` stays the primary key, so nothing about today's ranking moves;
     * the rest of the chain exists only to break ties the same way twice.
     *
     * Presentation only. It does NOT normalise the stored row: an edit draft,
     * a save payload and the live play screen each have their own legitimate
     * order, and re-sorting under a user who is typing would move rows out from
     * under their finger.
     *
     * @param {any[]} players
     * @returns {any[]} a sorted copy
     */
    static rankPlayers(players) {
      return (players || []).slice().sort((a, b) => {
        const sa = a.score == null ? -Infinity : a.score;
        const sb = b.score == null ? -Infinity : b.score;
        // Not `sb - sa`: two unscored players are both -Infinity and the
        // subtraction is NaN, which leaves the comparator lying about equality.
        if (sa !== sb) return sa < sb ? 1 : -1;
        const wa = a.is_winner ? 1 : 0;
        const wb = b.is_winner ? 1 : 0;
        if (wa !== wb) return wb - wa;
        const byName = String(a.name || "").localeCompare(String(b.name || ""));
        if (byName) return byName;
        // Ghosts carry no user_id and sort together under "". Two ghosts with
        // the same name and score are genuinely indistinguishable here; they
        // render identically too, so the ambiguity costs nothing.
        return String(a.user_id || "").localeCompare(String(b.user_id || ""));
      });
    }

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
        // thumbnail_url ONLY. `game_thumbnail` on a PlayResponse is
        // games.thumbnail_url (play_routes.py _build_play_response), so falling
        // back to the full-size image_url here made the seed disagree with the
        // row it is a projection of: a game with art but no thumbnail painted
        // one on the first frame that vanished when the fetch landed.
        game_thumbnail: g.thumbnail_url || null,
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
        // Migration 031. The popup gates its Rounds section on
        // hasRoundGrid(players, key, template), which needs only ONE round when
        // a template exists and two without one — so a seed missing this
        // rendered no grid at all on a single-round play and generic R1..Rn
        // labels on a multi-round one, and the confirming fetch then repainted
        // the whole card. `undefined` (a card from a pre-031 payload) is left
        // as undefined rather than nulled; seedFromFeedCard reads that
        // distinction.
        scoring_template: card.scoring_template,
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
      // Never let a card that predates 031 downgrade a seed that has the
      // template. The feed cache holds a 24h stale window, so for a day after
      // deploy some cards arrive with no such key at all — and the seed this
      // would overwrite may have come from a /plays page or from the row a PUT
      // echoed back, both of which carry it.
      //
      // The test is `undefined`, not falsiness: undefined means UNKNOWN (a
      // pre-031 payload) and keeps whatever is already held; null means this
      // play genuinely has no template and must be taken, or a play whose
      // template was removed would keep painting the old labels.
      if (play.scoring_template === undefined) {
        const prev = _seeds.get(card.play_id);
        play.scoring_template = prev ? prev.scoring_template : null;
      }
      _seeds.set(card.play_id, play);
      return play;
    }

    /**
     * Remember a play the client has in full — the row GET /plays/{id} or a PUT
     * echoed back. The popup calls this with its own fetch, so a second open of
     * the same play in one session paints once and never repaints.
     *
     * @param {any} play a PlayResponse
     */
    static remember(play) {
      if (!play || !play.id) return;
      _seeds.set(play.id, play);
    }

    /**
     * The remembered play, or null. Synchronous — this is its whole point.
     *
     * Falls back to a cached /plays page, so the surfaces that do NOT draw feed
     * cards — the plays log, the profile preview, notifications, the session
     * viewer — open on content rather than a spinner. Those pages have carried
     * the full row, scoring_template included, since migration 018; nothing had
     * ever wired them to the seed.
     */
    static seeded(id) {
      if (!id) return null;
      const held = _seeds.get(id);
      if (held) return held;
      const fromList = _seedFromCachedLists(id);
      // Memoise. `_seeds` is cleared wholesale by _invalidatePlayDeps, so this
      // inherits the existing invalidation story rather than adding one.
      if (fromList) _seeds.set(id, fromList);
      return fromList;
    }

    /**
     * The inverse of fromFeedCard: write a PlayResponse's fields onto a
     * feed-card-shaped object, IN PLACE.
     *
     * In place because every holder of that card — the cached feed page, the
     * feed store slot, ui/play-card.js's render registry — is holding the same
     * object by reference, which is what makes one patch reach all of them.
     * Idempotent for the same reason: these are plain field writes, so running
     * it twice over one card is the same as running it once.
     *
     * Only the fields a play OWNS are written. Everything a card carries that
     * the play does not know about — reaction counts and reactors, who logged
     * it, `kind` — is left alone, because a play edit does not change any of
     * it and inventing values would undo a tap the viewer just made.
     *
     * @param {any} card a feed play card
     * @param {any} play a PlayResponse
     * @returns {any} the same card
     */
    static mergeIntoCard(card, play) {
      if (!card || !play) return card;
      const prev = card.game || {};
      // A pivot (the edit moved the play to a different game) invalidates the
      // whole game block, not just its name: box art and theme colour belong
      // to the game that left. PlayResponse carries only the thumbnail, so the
      // full-size art falls back to it and the accent falls back to the
      // polaroid default rather than painting the previous game's identity
      // over the new one. The next real feed fetch restores both.
      card.game = prev.id && prev.id === play.game_id
        ? Object.assign({}, prev, {
            name: play.game_name,
            thumbnail_url: play.game_thumbnail || prev.thumbnail_url || null,
          })
        : {
            id: play.game_id,
            name: play.game_name,
            thumbnail_url: play.game_thumbnail || null,
            image_url: play.game_thumbnail || null,
          };
      card.played_at = play.played_at;
      card.notes = play.notes == null ? null : play.notes;
      card.photo_url = play.photo_url == null ? null : play.photo_url;
      card.play_mode = play.play_mode || "competitive";
      card.country_code = play.country_code == null ? null : play.country_code;
      card.players = play.players || [];
      card.expansions = play.expansions || [];
      // A play owns its template, so an edit that changed it has to reach the
      // card too. Without this the card's projection would keep saying
      // "unknown" and the seed would hold the pre-edit labels on the strength
      // of seedFromFeedCard's undefined guard — which is a backstop for stale
      // payloads, not a place to hide a field we know the new value of.
      card.scoring_template = play.scoring_template == null ? null : play.scoring_template;
      // group_count is deliberately NOT written. One card can stand for a whole
      // run of identical imported plays (migration 005), and PlayResponse
      // always says 1 — so copying it across would collapse a run of 58 into a
      // single play. Editing a play cannot change how many plays are in a run.
      return card;
    }

    /**
     * Fold an accepted edit into everything holding the old row.
     *
     * Order is load-bearing. The play-card patch re-renders the card, and
     * rendering a card re-seeds `_seeds` from its PROJECTION. Since 031 that
     * projection carries the scoring_template, and seedFromFeedCard holds the
     * previous one when a stale card has no such key — but the full row still
     * goes into the seed last, because it is the authoritative copy and the
     * card is a lossy view of it.
     *
     * @param {any} play the PlayResponse the PUT echoed back
     */
    static applyUpdate(play) {
      if (!play || !play.id) return;
      if (window.Feed && window.Feed.applyPlayUpdate) window.Feed.applyPlayUpdate(play);
      Play.applyToCachedLists(play);
      if (window.BgbPlayCard && window.BgbPlayCard.applyPlayUpdate) {
        window.BgbPlayCard.applyPlayUpdate(play);
      }
      Play.remember(play);
      // The Another Round card seeds off the viewer's most recent play. Before
      // this it was cleared outright on every edit — including an edit to that
      // very play, which is the one case where we now know exactly what it
      // should say. An edit to some OTHER play can still have moved which play
      // is most recent (the date is editable), and that we cannot answer from
      // here, so it keeps the clear.
      const last = Play.cachedLastPlay();
      if (last && last.id === play.id) Play.rememberLastPlay(play);
      else Play.rememberLastPlay(null);
    }

    /**
     * Patch the edited play into every cached /plays page that holds it.
     *
     * Each page is re-sorted by date afterwards, because played_at is editable
     * and it is the sort key — without that, nudging a play back a day leaves
     * it sitting above rows it now belongs below. A date change big enough to
     * move the play to a DIFFERENT page is not fixable from here (the paging is
     * offset-based); that corrects itself on the next revalidation, which is a
     * far smaller wrong than dropping every page and painting a spinner.
     *
     * @param {any} play
     */
    static applyToCachedLists(play) {
      if (!window.bgbCache || !play || !play.id) return;
      for (const key of window.bgbCache.keys(LIST_NS)) {
        const page = window.bgbCache.peek(LIST_NS, key);
        if (!page || !Play.applyToRows(page.plays, play)) continue;
        window.bgbCache.persist(LIST_NS, key);
      }
    }

    /**
     * Swap an edited play into ONE list of play rows, in place.
     *
     * Every list of plays in the app is the same rows in the same order — a
     * cached /plays page, the Plays log's in-memory array, the profile
     * bundle's `recent_plays` — because the SQL behind each of them selects a
     * PlayResponse-shaped row and orders it `played_at DESC, created_at DESC`.
     * So the patch a saved edit needs is one function, and the surfaces
     * holding those lists differ only in what they repaint afterwards.
     *
     * In place, for the same reason mergeIntoCard is: a view's array is often
     * the very object the cache holds, and one splice reaching both is the
     * point. Returns whether the list held the play so the caller can skip a
     * repaint it doesn't need.
     *
     * @param {any[]} rows a list of PlayResponse-shaped rows
     * @param {any} play the PlayResponse the PUT echoed back
     * @returns {boolean} true when `rows` held the play and now holds the edit
     */
    static applyToRows(rows, play) {
      if (!Array.isArray(rows) || !play || !play.id) return false;
      const i = _rowIndex(rows, play.id);
      if (i < 0) return false;
      rows[i] = play;
      _sortRows(rows);
      return true;
    }

    /**
     * Drop a deleted (or left) play from one list of play rows, in place.
     *
     * The counterpart to applyToRows, and the same contract: in place, and
     * true only when the row was actually there. The caller owns whatever
     * total sits beside the list — this cannot know whether the row it just
     * removed was counted in one.
     *
     * @param {any[]} rows
     * @param {string} playId
     * @returns {boolean}
     */
    static removeFromRows(rows, playId) {
      if (!Array.isArray(rows) || !playId) return false;
      const i = _rowIndex(rows, playId);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    }

    // ── Reactions ("Good game", migration 016) ─────────────────────────────
    //
    // Both take the whole night's play ids, because the surface is the session
    // footer: one tap covers every play in that session. The server drops any
    // of them the caller logged — you do not congratulate yourself — and echoes
    // back the ids it actually touched, which is why these return the response
    // rather than swallowing it: the caller's optimistic patch may have covered
    // more plays than the write did.
    //
    // Deliberately NOT routed through _invalidatePlayDeps(). A reaction changes
    // no play, no stat and no shelf; busting the caches would drop the feed page
    // and make every tap refetch the feed, which is the whole cost this design
    // was avoiding. The feed cards are patched in place by the view instead —
    // and, once the server has accepted the write, in the cached first page too
    // via Feed.applyReaction, or the patch would live only as long as the tab
    // does and a reload would paint the pre-tap state back.

    /** @param {string[]} playIds @returns {Promise<any>} */
    static react(playIds) {
      return window.api.post("/plays/reactions", { play_ids: playIds })
        .then((r) => { _patchFeedReactions(r, playIds, true); return r; });
    }

    /** @param {string[]} playIds @returns {Promise<any>} */
    static unreact(playIds) {
      return window.api.del("/plays/reactions", { play_ids: playIds })
        .then((r) => { _patchFeedReactions(r, playIds, false); return r; });
    }

    // Any play mutation can shift Profile stats, recent_plays, and the
    // played-not-owned shelf; it can also change Game Detail's recent_plays
    // for that game. Bust the bundle caches so the next visit re-hydrates.
    static create(payload) {
      return window.api.post("/plays", payload).then((r) => { _invalidatePlayDeps(); return r; });
    }
    // The PUT echoes the WHOLE play back — the server re-SELECTs it and
    // re-hydrates players and expansions before answering — so an edit is the
    // one mutation that hands us the correct new row. Fold it into every cache
    // that can hold it rather than dropping them and making the next reader
    // pay for a refetch it can't see the result of: "never refetch the whole
    // list after a mutation, patch the one changed item into local state"
    // (.claude/rules/web-frontend.md). The caches that CAN'T be patched from
    // one play — stats, achievements, shelves, the profile and game bundles —
    // are still dropped, by the same _invalidatePlayDeps as ever.
    static update(id, payload) {
      return window.api.put(`/plays/${id}`, payload).then((r) => {
        _invalidatePlayDeps({ patched: true });
        Play.applyUpdate(r);
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

  /**
   * Fold an accepted reaction write into the cached feed page.
   *
   * Keyed off the ids the SERVER echoes rather than the ids that were sent: a
   * react drops the caller's own plays, so the response is the only honest
   * account of what changed. Falls back to what was sent for an unreact, where
   * the echo is the whole list by construction.
   *
   * @param {any} res      the PlayReactionResponse
   * @param {string[]} sent
   * @param {boolean} reacted
   */
  function _patchFeedReactions(res, sent, reacted) {
    const ids = (res && Array.isArray(res.play_ids) && res.play_ids.length) ? res.play_ids : sent;
    if (window.Feed && window.Feed.applyReaction) window.Feed.applyReaction(ids, reacted);
  }

  // Note: the `play.last` seed is deliberately NOT cleared here. This also runs
  // for create / finalize / attachPhoto, which are exactly the moments the
  // Another Round card should be showing the play that just landed — the
  // caller (play-flow's _runSave) writes the fresh row into the seed. The
  // mutations that can genuinely destroy or reshape the top play (update,
  // remove, leave) clear it themselves.
  /**
   * @param {{patched?: boolean}} [opts] `patched: true` means the caller has
   *   the fresh row and is folding it in itself (Play.applyUpdate), so the
   *   three things that row can be patched INTO are left alone: the cached
   *   feed first page, the cached /plays pages, and the feed store slot whose
   *   subscriber re-renders the whole Feed view. Everything else is dropped
   *   exactly as before, because nothing here can derive it from one play.
   */
  function _invalidatePlayDeps(opts) {
    const patched = !!(opts && opts.patched);
    // Every seed, not the one that changed: this also fires for the bulk
    // import-group and import-batch deletes, which drop many plays at once and
    // whose ids the caller never enumerates. Clearing wholesale is free — the
    // feed cache is dropped a few lines below, so the next feed paint reseeds
    // from fresh rows anyway — and it cannot miss a mutation path. On the
    // patched path nothing reseeds it, so Play.applyUpdate puts the one play it
    // holds back afterwards.
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
    // Feed.applyPlayUpdate patches it in place instead on the patched path.
    if (window.bgbCache && !patched) window.bgbCache.delete("feed", "first");
    // Every cached /plays page can contain the row that just changed, and the
    // paging is offset-based, so a single insert shifts every page after it.
    // Namespace-wide is the only correct scope — for anything that INSERTS or
    // REMOVES a row. An edit does neither, so the patched path rewrites the row
    // where it sits (Play.applyToCachedLists) and keeps the pages.
    if (window.bgbCache && !patched) window.bgbCache.clear(LIST_NS);
    // last_played_at / play_count are the collection shelf's sort key.
    if (window.Collection && window.Collection.invalidateShelves) {
      window.Collection.invalidateShelves();
    }
    if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
    // Profile.invalidate() above drops the cached bundle; this is the SAME
    // payload published to the store by views/profile-self-view.js, and the
    // Plays and Collection spokes fall back to it when the cache misses. Left
    // behind, it re-seeded the pre-edit play the cache drop had just removed.
    if (window.store && window.store.set) window.store.set("profileBundle", null);
    // A create or a delete changes which cards the feed HAS, so the view has
    // to rebuild. An edit changes one card's contents, and ui/play-card.js
    // repaints exactly that card in place — a full render here would reset the
    // feed's scroll position and flip every open card back over for nothing
    // (views/feed-view.js says as much above its own _syncCardStatus).
    if (!patched) window.store.invalidate("feed");
  }

  window.Play = Play;
})();
