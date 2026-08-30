// domain/expansion-tree.js — Groups a flat owned shelf into base game → the
// expansions you own, for the Collection spoke's Expansions tab.
//
// Pure reshape, no I/O. The rows come from Collection.shelf(target, "owned",
// { includeExpansions: true }), which already carries everything needed:
// game.is_expansion, game.base_game_bgg_id and game.bgg_id.
//
// Grouping is client-side rather than in bgb_collection_shelf on purpose.
// Nesting in SQL would silently drop the two cases the orphan bucket below
// exists to surface: an owned expansion whose base game you don't own, and one
// whose denormalized base_game_bgg_id is NULL because the row was written
// before the expansion got pinned to a base game.

// @ts-check

(function () {
  /**
   * @typedef {Object} ExpansionGroup
   * @property {string|null} baseId    Base game UUID, or null for the orphan bucket.
   * @property {string} name           Base game name, or the orphan bucket's label.
   * @property {any|null} base         The base game's CollectionItem, or null.
   * @property {any[]} kids            Owned expansion CollectionItems under it.
   * @property {number} catalogCount   Expansions BgB knows about for this base game.
   * @property {boolean} canAdd        False for the orphan bucket — nothing to add to.
   */

  const ORPHAN_LABEL = "Not in your collection";

  /**
   * @param {any[]} items Flat rows from the owned shelf, expansions included.
   * @returns {{groups: ExpansionGroup[], totalOwned: number}}
   */
  function buildExpansionTree(items) {
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
      if (group) group.kids.push(it);
      else orphans.push(it);
    }

    // Groups holding something come first — otherwise you scroll past every
    // empty base game to reach the expansions the tab exists to show. Order is
    // stable within each partition, so the shelf's own ordering (last played,
    // then most recently added) still shows through.
    const filled = groups.filter((g) => g.kids.length > 0);
    const empty = groups.filter((g) => g.kids.length === 0);
    const ordered = filled.concat(empty);

    if (orphans.length) {
      ordered.push({
        baseId: null,
        name: ORPHAN_LABEL,
        base: null,
        kids: orphans,
        catalogCount: 0,
        canAdd: false,
      });
    }

    // Counted off the rows themselves, not off Collection's
    // expansion-count-by-base-bgg-id map: that map is keyed by base game, so
    // it can't see the orphans, and the pill has to match what's on screen.
    let totalOwned = 0;
    for (const g of ordered) totalOwned += g.kids.length;

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
