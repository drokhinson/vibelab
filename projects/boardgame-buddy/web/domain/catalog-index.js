// @ts-check
// domain/catalog-index.js — the whole base-game catalog, on the device, for
// the game picker to search without a request.
//
// The Gather picker (widgets/game-finder.js) used to ask /search on every
// keystroke past two characters: a debounce, a Railway → Supabase round trip,
// and a repaint when the answer landed — all sharing one uvicorn worker with
// the host's 2s lobby poll and one poll per joiner. For a string match over a
// catalog of a couple of thousand names, that is the wrong side of the wire.
//
// This pulls GET /search/index once — one compact row per base game: id, name
// and what a result row paints (year, players, time, thumb) — and answers a
// keystroke synchronously from memory. Same shape as Collection.shelf: fetch
// the whole thing, cache it, derive every answer locally.
//
// What the row does NOT carry: box art, rulebook, play mode, bgg_id. A pick
// that needs those hydrates from GET /games/{id} (server-cached an hour) —
// the finder does that, see GameFinder._pickById. Every row is marked
// `_partial: true` so a consumer can tell.
//
// Size and growth. At ~120 bytes a row the user's catalog is a few hundred KB
// raw and tens of KB on the wire (the API gzips). It is persisted to
// localStorage only while its serialisation stays under PERSIST_CAP_BYTES, so
// a catalog that grows past that stops competing with the game bundles for
// the 3 MB budget and lives in memory for the page session instead — one
// fetch per launch, from an idle callback. Past the server's own hard cap the
// response says `truncated`, and peek() reports it so the finder keeps
// /search as the authority.
//
// Matching is case-insensitive SUBSTRING, to agree with /search's
// ILIKE '%q%' (and with domain/shelf-filter.js's matchesName). Ranking is
// where this improves on the server: exact > prefix > word-prefix > contains,
// and inside each rung the viewer's own collection first — which is the
// collection-first ordering /search does in SQL, done here from the status map
// bootstrap already warmed.

(function () {
  const NS = "game.catalog";
  const KEY = "index";
  // Fresh for ten minutes, matching the server-side build TTL; served stale
  // for a day so a reopened tab paints from what it had while refreshing.
  const FRESH_TTL_MS = 10 * 60 * 1000;
  const STALE_TTL_MS = 24 * 60 * 60 * 1000;
  // Above this the entry is memory-only. ~5k rows at today's row size.
  const PERSIST_CAP_BYTES = 600 * 1024;

  /**
   * @typedef {Object} IndexRow
   * @property {string} id
   * @property {string} name
   * @property {number|null} [y]   year_published
   * @property {number|null} [mn]  min_players
   * @property {number|null} [mx]  max_players
   * @property {number|null} [t]   playing_time
   * @property {string|null} [th]  thumbnail key under thumb_base, or absolute URL
   */

  /**
   * @typedef {Object} IndexPayload
   * @property {IndexRow[]} games
   * @property {number} count
   * @property {boolean} truncated
   * @property {string} thumb_base
   * @property {string} generated_at
   */

  /**
   * @typedef {Object} CatalogGame  GameSummary-shaped, minus the fields the
   *   index does not carry.
   * @property {string} id
   * @property {string} name
   * @property {number|null} year_published
   * @property {number|null} min_players
   * @property {number|null} max_players
   * @property {number|null} playing_time
   * @property {string|null} thumbnail_url
   * @property {false} is_expansion
   * @property {true} _partial
   */

  /** @type {{ payload: IndexPayload, rows: Array<{game: CatalogGame, lower: string}> }|null} */
  let _built = null;

  /** @param {IndexPayload} payload @returns {IndexPayload} */
  function _normalisePayload(payload) {
    return {
      games: Array.isArray(payload && payload.games) ? payload.games : [],
      count: (payload && payload.count) || 0,
      truncated: !!(payload && payload.truncated),
      thumb_base: (payload && payload.thumb_base) || "",
      generated_at: (payload && payload.generated_at) || "",
    };
  }

  /**
   * Widen one wire row back into the GameSummary field names every render
   * function in the app reads, and reassemble the cover URL.
   * @param {IndexRow} r @param {string} base @returns {CatalogGame}
   */
  function _widen(r, base) {
    let thumb = r.th || null;
    if (thumb && !/^https?:\/\//i.test(thumb)) thumb = base ? `${base}/${thumb}` : null;
    return {
      id: r.id,
      name: r.name,
      year_published: r.y == null ? null : r.y,
      min_players: r.mn == null ? null : r.mn,
      max_players: r.mx == null ? null : r.mx,
      playing_time: r.t == null ? null : r.t,
      thumbnail_url: thumb,
      is_expansion: false,
      _partial: true,
    };
  }

  /**
   * The searchable form of a payload: each row widened once, with its
   * lower-cased name beside it so a keystroke is one indexOf per row.
   * Memoised on payload identity — the cache hands back the same object until
   * a refresh replaces it.
   * @param {IndexPayload|null} payload
   */
  function _rowsFor(payload) {
    if (!payload) return null;
    if (_built && _built.payload === payload) return _built.rows;
    const base = payload.thumb_base || "";
    const rows = [];
    for (const r of payload.games) {
      if (!r || !r.id || !r.name) continue;
      rows.push({ game: _widen(r, base), lower: String(r.name).toLowerCase() });
    }
    _built = { payload, rows };
    return rows;
  }

  async function _fetch() {
    const data = await window.api.get("/search/index");
    return _normalisePayload(data);
  }

  /**
   * How well `lower` answers `q` — lower is better. Both already lower-cased.
   * Mirrors search_service._name_rank's ladder, minus the rungs that only
   * matter for BoardGameGeek's alias matches.
   * @param {string} q @param {string} lower @returns {number} 0..3, or -1 for no match
   */
  function _rank(q, lower) {
    const at = lower.indexOf(q);
    if (at < 0) return -1;
    if (lower === q) return 0;
    if (at === 0) return 1;
    // A word boundary: the character before the hit is not a letter/digit.
    if (!/[a-z0-9]/i.test(lower.charAt(at - 1))) return 2;
    return 3;
  }

  class CatalogIndex {
    /**
     * Load (or refresh) the index. Resolves to the payload; the rows are
     * derived lazily by search()/peek(). Safe to call often — the cache
     * single-flights it and no-ops inside the fresh window.
     * @returns {Promise<IndexPayload>}
     */
    static ensure() {
      return window.bgbCache.swr(NS, KEY, _fetch, {
        freshTtl: FRESH_TTL_MS,
        staleTtl: STALE_TTL_MS,
        persist: (json) => !!json && json.length <= PERSIST_CAP_BYTES,
      });
    }

    /**
     * Synchronous: is there an index to search right now? Serves the whole
     * stale window and never kicks a fetch — the caller pairs it with
     * ensure() for that.
     * @returns {{ rows: number, truncated: boolean }|null}
     */
    static peek() {
      if (!window.bgbCache) return null;
      const payload = /** @type {IndexPayload|null} */ (window.bgbCache.peek(NS, KEY));
      const rows = _rowsFor(payload);
      if (!rows) return null;
      return { rows: rows.length, truncated: !!(payload && payload.truncated) };
    }

    /**
     * Synchronous ranked substring search over the cached index.
     *
     * @param {string} q
     * @param {{ limit?: number, statusMap?: Record<string, string>|null }} [opts]
     *   `statusMap` — gameId → collection status; games present in it rank
     *   ahead of the rest of the catalog within the same match rung, which is
     *   the collection-first ordering /search does server-side.
     * @returns {CatalogGame[]}
     */
    static search(q, opts) {
      const o = opts || {};
      const limit = o.limit == null ? 20 : o.limit;
      const needle = String(q == null ? "" : q).trim().toLowerCase();
      if (!needle || !window.bgbCache) return [];
      const rows = _rowsFor(/** @type {IndexPayload|null} */ (window.bgbCache.peek(NS, KEY)));
      if (!rows) return [];
      const status = o.statusMap || null;
      /** @type {Array<{game: CatalogGame, rank: number, mine: number}>} */
      const hits = [];
      for (const row of rows) {
        const rank = _rank(needle, row.lower);
        if (rank < 0) continue;
        hits.push({ game: row.game, rank, mine: status && status[row.game.id] ? 0 : 1 });
      }
      // Rows come name-ordered from the server, and the sort is stable, so
      // alphabetical is the tiebreak for free.
      hits.sort((a, b) => (a.rank - b.rank) || (a.mine - b.mine));
      return hits.slice(0, limit).map((h) => h.game);
    }

    /** Drop the cached index so the next ensure() rebuilds it. */
    static invalidate() {
      _built = null;
      if (window.bgbCache) window.bgbCache.delete(NS, KEY);
    }
  }

  window.CatalogIndex = CatalogIndex;
})();
