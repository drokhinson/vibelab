// domain/rank.js — the viewer's game ranking (migration 056).
//
// A game is ranked against the other games in ITS category, which the server
// decides from BoardGameGeek's family lists — the client never picks one. Three
// reads, one write (DELETE /ranks/games/{id} exists; nothing here offers it yet):
//
//   summary()  every ranked game's "#N Category", held whole (tens of rows). The
//              game page pill and the Collection top-5 chips read it.
//   queue()    owned or played games with no rank yet, A to Z.
//   context()  one game's category, current rank, and the list it is ranked
//              against — fetched fresh each time the sheet opens, because the
//              questions binary-search into exactly that list.
//   place()    write a tier + index; busts summary and queue and fires
//              `ranks-changed` so every surface showing a rank repaints.

(function () {
  const NS = "rank";
  const SUMMARY_KEY = "summary";
  const QUEUE_KEY = "queue";
  const FRESH_TTL_MS = 60 * 1000;
  const STALE_TTL_MS = 10 * 60 * 1000;

  // Declared best first; a category's list stacks them in this order.
  const TIERS = [
    { id: "love", label: "Love it", icon: "chevron-up" },
    { id: "good", label: "A good game", icon: "minus" },
    { id: "not", label: "Not for me", icon: "chevron-down" },
  ];

  function _changed(gameId) {
    window.bgbCache.delete(NS, SUMMARY_KEY);
    window.bgbCache.delete(NS, QUEUE_KEY);
    document.dispatchEvent(new CustomEvent("ranks-changed", { detail: { gameId } }));
  }

  class Rank {
    static get TIERS() { return TIERS; }

    /** @returns {Promise<Object<string, {game_id:string, category:string, category_label:string, tier:string, position:number}>>} */
    static async summary({ force = false } = {}) {
      if (force) window.bgbCache.delete(NS, SUMMARY_KEY);
      const data = await window.bgbCache.swr(NS, SUMMARY_KEY,
        () => window.api.get("/ranks"),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS });
      const map = {};
      for (const r of (data && data.ranks) || []) map[r.game_id] = r;
      return map;
    }

    /** @returns {Promise<Array<{game:Object, category:string, category_label:string}>>} */
    static async queue({ force = false } = {}) {
      if (force) window.bgbCache.delete(NS, QUEUE_KEY);
      const data = await window.bgbCache.swr(NS, QUEUE_KEY,
        () => window.api.get("/ranks/queue"),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS });
      return (data && data.items) || [];
    }

    static context(gameId) {
      return window.api.get(`/ranks/games/${encodeURIComponent(gameId)}`);
    }

    static async place(gameId, tier, index) {
      const entry = await window.api.put(`/ranks/games/${encodeURIComponent(gameId)}`, { tier, index });
      _changed(gameId);
      return entry;
    }
  }

  window.Rank = Rank;
})();
