// @ts-check
// domain/rank-shelf.js — the Collection's ranking view, derived from the cached
// ranking (domain/rank.js). Pure: no fetch, no DOM.
//
// Each category is ranked on its own, so "#3 Family" and "#3 Party" say nothing
// about each other. "All" therefore merges on the 10-point score, whose tier
// bands never overlap (a loved game always outscores a merely good one), and
// breaks ties on the place within its own category.

(function () {
  const ALL = "all";

  // The server's listing order (rank_category.CATEGORY_LABELS), most common
  // first. A category missing here still lists, after these.
  const ORDER = [
    "strategy", "family", "party", "thematic", "war", "abstract",
    "children", "customizable", "card", "two_player", "coop",
  ];

  /**
   * @typedef {Object} RankEntry
   * @property {string} game_id
   * @property {string} category
   * @property {string} category_label
   * @property {string} tier
   * @property {number} position
   * @property {number} score
   * @property {{id:string, name:string}} [game]
   */

  /** @param {Object<string, RankEntry>|null} summary */
  function _entries(summary) {
    return Object.values(summary || {}).filter((e) => e && e.game);
  }

  function _orderIdx(cat) {
    const i = ORDER.indexOf(cat);
    return i === -1 ? ORDER.length : i;
  }

  const RankShelf = {
    ALL,

    /**
     * The dropdown's rows: "All Game Types" first, then each category the
     * viewer has ranked something in.
     * @param {Object<string, RankEntry>|null} summary
     * @returns {{id:string, label:string, icon:string, count:number}[]}
     */
    categories(summary) {
      const entries = _entries(summary);
      const byCat = new Map();
      for (const e of entries) {
        const row = byCat.get(e.category);
        if (row) row.count++;
        else byCat.set(e.category, { id: e.category, label: e.category_label || e.category, icon: "trophy", count: 1 });
      }
      const cats = [...byCat.values()].sort((a, b) =>
        _orderIdx(a.id) - _orderIdx(b.id) || a.label.localeCompare(b.label));
      return [{ id: ALL, label: "All Game Types", icon: "list-numbers", count: entries.length }, ...cats];
    },

    /** The label for a category id, or "All Game Types". */
    label(summary, category) {
      if (category === ALL) return "All Game Types";
      const hit = _entries(summary).find((e) => e.category === category);
      return hit ? hit.category_label : "All Game Types";
    },

    /**
     * Ranked games in order, narrowed to one category (or ALL) and a name query.
     * @param {Object<string, RankEntry>|null} summary
     * @param {string} category
     * @param {string} [query]
     * @returns {RankEntry[]}
     */
    list(summary, category, query) {
      const match = window.ShelfFilter.matchesName;
      const rows = _entries(summary).filter((e) =>
        (category === ALL || e.category === category)
        && (!query || match(e.game && e.game.name, query)));
      const byName = (a, b) => String(a.game && a.game.name).localeCompare(String(b.game && b.game.name));
      if (category === ALL) {
        rows.sort((a, b) => b.score - a.score || a.position - b.position || byName(a, b));
      } else {
        rows.sort((a, b) => a.position - b.position || byName(a, b));
      }
      return rows;
    },
  };

  window.RankShelf = RankShelf;
})();
