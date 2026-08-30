// domain/expansion-tree.js — Groups a flat owned shelf into base game → its
// expansions, for the Collection spoke's Expansions tab.
//
// Pure reshape, no I/O. The owned rows come from Collection.shelf(target,
// "owned", { includeExpansions: true }), which already carries everything
// needed: game.is_expansion, game.base_game_bgg_id and game.bgg_id.
//
// In "show all" mode the catalog rows from Collection.expansionCatalog() are
// merged in as unowned kids, so a group lists everything BgB has for that base
// game and the ones you don't own yet are greyed out but addable in place.
//
// Grouping is client-side rather than in bgb_collection_shelf on purpose.
// Nesting in SQL would silently drop the two cases the orphan bucket below
// exists to surface: an owned expansion whose base game you don't own, and one
// whose denormalized base_game_bgg_id is NULL because the row was written
// before the expansion got pinned to a base game.

// @ts-check

(function () {
  /**
   * @typedef {Object} ExpansionKid
   * @property {string} gameId  Expansion game UUID.
   * @property {any} game       Game-shaped object for the row renderer.
   * @property {boolean} owned  False for catalog rows shown by "show all".
   */

  /**
   * @typedef {Object} ExpansionGroup
   * @property {string|null} baseId    Base game UUID, or null for the orphan bucket.
   * @property {string} name           Base game name, or the orphan bucket's label.
   * @property {any|null} base         The base game's CollectionItem, or null.
   * @property {ExpansionKid[]} kids   Owned first, then unowned when showing all.
   * @property {number} ownedCount     Kids you own — what the tally's left half reads.
   * @property {number} catalogCount   Expansions BgB knows about for this base game.
   * @property {boolean} canAdd        False for the orphan bucket — nothing to add to.
   */

  const ORPHAN_LABEL = "Not in your collection";

  /** The collection screens' one name comparator — see domain/shelf-filter.js. */
  function compareNames(a, b) {
    return window.ShelfFilter.compareGameNames(a, b);
  }
  function byKidName(a, b) {
    const byName = compareNames(a.game && a.game.name, b.game && b.game.name);
    return byName !== 0 ? byName : String(a.gameId || "").localeCompare(String(b.gameId || ""));
  }

  /** Normalize a shelf row's game into the kid shape. */
  function _ownedKid(item) {
    return { gameId: item.game_id, game: item.game || {}, owned: true };
  }

  /** Normalize a catalog row (ExpansionListItem) into the kid shape. */
  function _catalogKid(row) {
    return {
      gameId: row.expansion_game_id,
      game: {
        id: row.expansion_game_id,
        bgg_id: row.bgg_id,
        name: row.name,
        thumbnail_url: row.thumbnail_url,
        image_url: row.image_url,
        is_expansion: true,
        base_game_bgg_id: row.base_game_bgg_id,
        expansion_color: row.color,
        expansion_count: 0,
      },
      owned: false,
    };
  }

  /**
   * @param {any[]} items Flat owned rows, expansions included.
   * @param {{catalog?: any[], showAll?: boolean}} [opts]
   * @returns {{groups: ExpansionGroup[], totalOwned: number}}
   */
  function buildExpansionTree(items, { catalog = null, showAll = false } = {}) {
    const rows = Array.isArray(items) ? items : [];
    const bases = [];
    const expansions = [];
    for (const it of rows) {
      const g = (it && it.game) || {};
      if (g.is_expansion) expansions.push(it);
      else bases.push(it);
    }

    // bgg_id → group, because the base↔expansion link is bgg_id to bgg_id, not
    // a UUID foreign key (see shared-backend .../expansion_routes.py).
    const byBggId = new Map();
    const groups = [];
    for (const it of bases) {
      const g = it.game || {};
      // A base game the catalog has no expansions for can't gain one here and
      // has nothing to nest, so it would be pure noise in this view. That
      // count is already on the row.
      if (!(g.expansion_count > 0)) continue;
      const group = {
        baseId: g.id,
        name: g.name || "Unknown",
        base: it,
        kids: [],
        ownedCount: 0,
        catalogCount: g.expansion_count || 0,
        canAdd: true,
      };
      groups.push(group);
      if (g.bgg_id != null) byBggId.set(g.bgg_id, group);
    }

    const orphans = [];
    for (const it of expansions) {
      const g = it.game || {};
      const group = g.base_game_bgg_id != null ? byBggId.get(g.base_game_bgg_id) : null;
      if (group) group.kids.push(_ownedKid(it));
      else orphans.push(_ownedKid(it));
    }
    for (const g of groups) g.ownedCount = g.kids.length;

    // The shelf arrives in the server's recency order; every collection screen
    // shows games by name, and a group's kids are games. Sorted before the
    // catalog merge so the unowned tail still lands after the owned half.
    for (const g of groups) g.kids.sort(byKidName);
    orphans.sort(byKidName);

    // Merge the catalog in as unowned kids, appended after the owned ones so
    // what you have stays at the top of every group. Both halves are
    // alphabetical in their own right.
    if (showAll && Array.isArray(catalog)) {
      const seen = new Set();
      for (const g of groups) for (const k of g.kids) seen.add(k.gameId);
      const extra = new Map();
      for (const row of catalog) {
        if (!row || seen.has(row.expansion_game_id)) continue;
        const group = row.base_game_bgg_id != null ? byBggId.get(row.base_game_bgg_id) : null;
        if (!group) continue;
        if (!extra.has(group)) extra.set(group, []);
        extra.get(group).push(_catalogKid(row));
      }
      for (const [group, kids] of extra) {
        kids.sort(byKidName);
        group.kids = group.kids.concat(kids);
      }
    }

    // Groups holding something come first — otherwise you scroll past every
    // empty base game to reach the expansions the tab exists to show. Within
    // each partition the base games are alphabetical, matching the Owned and
    // Played grids. In show-all mode "holding something" means any kid at all,
    // since an unowned row is the thing you came to tap.
    const has = (g) => (showAll ? g.kids.length > 0 : g.ownedCount > 0);
    const byName = [...groups].sort((a, b) => compareNames(a.name, b.name));
    const ordered = byName.filter(has).concat(byName.filter((g) => !has(g)));

    if (orphans.length) {
      ordered.push({
        baseId: null,
        name: ORPHAN_LABEL,
        base: null,
        kids: orphans,
        ownedCount: orphans.length,
        catalogCount: 0,
        canAdd: false,
      });
    }

    // Counted off the rows themselves, not off Collection's
    // expansion-count-by-base-bgg-id map: that map is keyed by base game, so
    // it can't see the orphans, and the pill has to match what's on screen.
    // Unowned kids never count — the pill says what you have.
    let totalOwned = 0;
    for (const g of ordered) totalOwned += g.ownedCount;

    return { groups: ordered, totalOwned };
  }

  /**
   * Which groups start expanded: none of them.
   *
   * They used to open whenever they held anything, which on a real shelf meant
   * the tab opened as one undifferentiated wall of rows — and in "show all"
   * mode, where every group lists the entire catalog for its base game, there
   * was no way to see what you own without scrolling past everything you
   * don't. Closed by default makes the tab an index you drill into, and the
   * expand-all control next to the show-all switch reaches the old view in one
   * tap.
   *
   * Every group is named explicitly rather than returning {}: the caller
   * merges this with `if (!(key in open))`, so an absent key would leave a
   * newly-appearing group undefined rather than closed.
   */
  function defaultOpenState(groups) {
    const open = {};
    for (const g of groups || []) open[String(g.baseId)] = false;
    return open;
  }

  window.buildExpansionTree = buildExpansionTree;
  window.expansionTreeDefaultOpen = defaultOpenState;
})();
