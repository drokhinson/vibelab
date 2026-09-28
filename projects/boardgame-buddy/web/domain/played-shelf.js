// @ts-check
// domain/played-shelf.js — the Collection's Most played order: every game the
// viewer has played, from any shelf, most plays first. Pure: no fetch, no DOM.
//
// It is built from the three flat shelves the Collection already holds. Each
// shelf row carries `play_count` and `played_before` (the played mark,
// migration 057), and a game is on exactly one of them (a played-but-unowned
// game is on Played only; a sold one stays on Owned), so the union needs no
// request of its own. A marked game with no logged play counts as played, as
// it does everywhere else, and sorts after every logged one.

(function () {
  // Which row speaks for a game should it ever arrive twice: the status tag
  // and the prev-owned dim read the row.
  const PREFERENCE = ["owned", "played", "wishlist"];

  const PlayedShelf = {
    /**
     * @param {{owned?: Object[], played?: Object[], wishlist?: Object[]}} shelves
     *   Each shelf's rows, unfiltered.
     * @param {string} [query] Name search.
     * @returns {Object[]} Rows with a logged play or the played mark, most
     *   played first.
     */
    list(shelves, query) {
      const match = window.ShelfFilter.matchesName;
      const byGame = new Map();
      for (const key of PREFERENCE) {
        for (const it of (shelves && shelves[key]) || []) {
          if (!it || !it.game || byGame.has(it.game_id)) continue;
          if (!(it.play_count > 0) && !it.played_before) continue;
          if (query && !match(it.game.name, query)) continue;
          byGame.set(it.game_id, it);
        }
      }
      return [...byGame.values()].sort((a, b) =>
        b.play_count - a.play_count
        || String(a.game.name).localeCompare(String(b.game.name)));
    },
  };

  window.PlayedShelf = PlayedShelf;
})();
