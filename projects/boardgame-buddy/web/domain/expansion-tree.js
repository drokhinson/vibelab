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

    // Merge the catalog in as unowned kids. Owned rows keep their shelf order
    // (last played, then most recently added); the rest follow alphabetically,
    // so what you have stays at the top of every group.
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
        kids.sort((a, b) => String(a.game.name).localeCompare(String(b.game.name)));
        group.kids = group.kids.concat(kids);
      }
    }

    // Groups holding something come first — otherwise you scroll past every
    // empty base game to reach the expansions the tab exists to show. Order is
    // stable within each partition, so the shelf's own ordering still shows
    // through. In show-all mode "holding something" means any kid at all,
    // since an unowned row is the thing you came to tap.
    const has = (g) => (showAll ? g.kids.length > 0 : g.ownedCount > 0);
    const ordered = groups.filter(has).concat(groups.filter((g) => !has(g)));

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

  /** Which groups start expanded: the ones with something in them. */
  function defaultOpenState(groups) {
    const open = {};
    for (const g of groups || []) {
      if (g.kids.length > 0) open[String(g.baseId)] = true;
    }
    return open;
  }

  window.buildExpansionTree = buildExpansionTree;
  window.expansionTreeDefaultOpen = defaultOpenState;
})();
