// @ts-check
// domain/shelf-filter.js — client-side twin of the server's collection-grid
// filtering, plus the shared playtime buckets and a page slicer.
//
// The Profile games list used to ask /collection/grid for every page, filter
// tap and debounced keystroke. It now pulls a whole shelf once (see
// Collection.shelf) and derives the visible rows locally, which means these
// predicates have to agree with the backend exactly. `_passesShelfFilters` is a
// line-for-line port of `_passes_grid_filters`
// (shared-backend/routes/boardgame_buddy/collection_routes.py:254-282) and
// must be kept in step with it — three behaviours look like bugs and are not:
//
//   1. Search is a plain case-insensitive SUBSTRING test, not prefix or fuzzy.
//   2. The `players < 6` guard: the "6+" chip deliberately skips the
//      min_players check, so a 7-player-minimum game still matches "6+".
//   3. `playing_time || 0` means a game with no playtime recorded PASSES a
//      playtime_max filter but FAILS a playtime_min one.
//
// The Collection spoke calls this through ShelfController for each of its flat
// shelves (owned, wishlist, played). Its Expansions tree is not a shelf and has
// no ShelfFilter pass, but its search still goes through `matchesName` below so
// the two never disagree about what "Cafe" matches. The spoke scrolls rather
// than pages and slices the window itself; `pageOf` below is left for the Game
// Explorer, which is still paged.

(function () {
  /**
   * @typedef {Object} ShelfFilters
   * @property {string|null} [search]       Case-insensitive substring of the game name.
   * @property {number|null} [players]      Player count the game must seat.
   * @property {number|null} [playtimeMin]
   * @property {number|null} [playtimeMax]
   * @property {string|null} [playMode]     "competitive" | "coop" | "team"
   * @property {boolean} [excludeExpansions] Defaults to true, matching the endpoint.
   */

  const PLAYTIME_BUCKETS = [
    { id: "u30",   label: "< 30 min",   min: null, max: 29 },
    { id: "30-60", label: "30–60 min",  min: 30,   max: 60 },
    { id: "60-90", label: "60–90 min",  min: 60,   max: 90 },
    { id: "90-120",label: "90–120 min", min: 90,   max: 120 },
    { id: "o120",  label: "2+ hours",   min: 120,  max: null },
  ];

  /** @param {{min:number|null,max:number|null}} b @param {{playtimeMin:number|null,playtimeMax:number|null}} f */
  function isActiveBucket(b, f) {
    return f.playtimeMin === b.min && f.playtimeMax === b.max;
  }

  /**
   * The one name test the search box means, wherever it is typed. Substring,
   * not prefix, and NOT trimmed — this mirrors the server's
   * `search.lower() not in name` exactly, and the truncated-shelf path sends
   * the same query on to that endpoint, so trimming here would make the local
   * and server halves of one search disagree. An empty query matches
   * everything, so a cleared box filters nothing.
   * @param {any} name @param {any} query @returns {boolean}
   */
  function matchesName(name, query) {
    const q = String(query == null ? "" : query).toLowerCase();
    if (!q) return true;
    return String(name == null ? "" : name).toLowerCase().includes(q);
  }

  /**
   * Does one game row survive the active filters?
   * @param {any} game  A CollectionItem.game payload.
   * @param {ShelfFilters} f
   * @returns {boolean}
   */
  function passesShelfFilters(game, f) {
    if (!game) return false;
    const excludeExpansions = f.excludeExpansions !== false;
    if (excludeExpansions && game.is_expansion) return false;

    if (f.search && !matchesName(game.name, f.search)) return false;

    if (f.players != null) {
      const mn = game.min_players;
      const mx = game.max_players;
      if (mx != null && mx < f.players) return false;
      // Intentional: at 6+ the chip means "at least this many", so a game
      // that requires more players than the chip still qualifies.
      if (f.players < 6 && mn != null && mn > f.players) return false;
    }

    // A null/0 playing_time collapses to 0 — passes a max filter, fails a min.
    const pt = game.playing_time || 0;
    if (f.playtimeMin != null && pt < f.playtimeMin) return false;
    if (f.playtimeMax != null && pt > f.playtimeMax) return false;

    if (f.playMode != null && game.play_mode !== f.playMode) return false;
    return true;
  }

  /**
   * Filter a shelf, preserving the incoming order. Ordering is a separate
   * step — see sortShelf below, which every collection screen applies after
   * this one.
   * @param {any[]} items @param {ShelfFilters} f @returns {any[]}
   */
  function filterShelf(items, f) {
    if (!Array.isArray(items)) return [];
    return items.filter((it) => passesShelfFilters(it && it.game, f));
  }

  // Numeric so "Catan 10" follows "Catan 2" rather than preceding it, and
  // base sensitivity so case and accents don't split a run ("Café" sits next
  // to "Cafe", "the Crew" next to "The Crew"). Built once — constructing a
  // collator per comparison is the expensive part of Intl.
  const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  /**
   * Compare two game names. The one comparator the collection screens sort by
   * — the expansion tree (domain/expansion-tree.js) sorts its groups and kids
   * through this too, so a base game and a shelf tile never disagree about
   * where a name belongs.
   * @param {any} a @param {any} b @returns {number}
   */
  function compareGameNames(a, b) {
    return NAME_COLLATOR.compare(String(a || ""), String(b || ""));
  }

  /**
   * Compare two shelf rows by game name. The game id breaks ties so two rows
   * that collate equal keep a fixed position across re-derives instead of
   * swapping places on a repaint.
   * @param {any} a @param {any} b @returns {number}
   */
  function compareShelfRows(a, b) {
    const byName = compareGameNames(a && a.game && a.game.name, b && b.game && b.game.name);
    if (byName !== 0) return byName;
    return String((a && a.game_id) || "").localeCompare(String((b && b.game_id) || ""));
  }

  /**
   * A shelf in the order every collection screen shows it: alphabetical by
   * game name. The server returns shelves by recency (last_played DESC NULLS
   * LAST then added_at DESC; wishlist by added_at DESC), which is still what
   * the Profile hub's preview strip and the feed want, so the reordering
   * happens here rather than at the endpoint.
   *
   * Copies rather than sorting in place — `items` is the cached shelf, shared
   * with every other reader of Collection.shelf().
   * @param {any[]} items @returns {any[]}
   */
  function sortShelf(items) {
    return (Array.isArray(items) ? items.slice() : []).sort(compareShelfRows);
  }

  /**
   * One page out of an already-filtered list. Clamps the page into range so a
   * filter change that shrinks the list can't strand the user on a blank page.
   * @param {any[]} items @param {number} page 1-based @param {number} perPage
   * @returns {{ rows: any[], page: number, totalPages: number, total: number }}
   */
  function pageOf(items, page, perPage) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(Math.max(1, page | 0 || 1), totalPages);
    const offset = (safePage - 1) * perPage;
    return { rows: list.slice(offset, offset + perPage), page: safePage, totalPages, total };
  }

  window.ShelfFilter = {
    PLAYTIME_BUCKETS,
    isActiveBucket,
    matchesName,
    passesShelfFilters,
    filterShelf,
    compareGameNames,
    compareShelfRows,
    sortShelf,
    pageOf,
  };
})();
