// domain/rank.js — the viewer's game ranking (migration 056).
//
// A game is ranked against the other games in ITS category, which the server
// decides from BoardGameGeek's family lists — the client never picks one. Three
// reads, one write (DELETE /ranks/games/{id} exists; nothing here offers it yet):
//
//   summary()  every ranked game's place and score, held whole (tens of rows). The
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

  function _byGame(data) {
    const map = {};
    for (const r of (data && data.ranks) || []) map[r.game_id] = r;
    return map;
  }

  function _changed(gameId) {
    window.bgbCache.delete(NS, SUMMARY_KEY);
    window.bgbCache.delete(NS, QUEUE_KEY);
    document.dispatchEvent(new CustomEvent("ranks-changed", { detail: { gameId } }));
  }

  // A game this high in its category is named by its place; below it, by its
  // rating out of 10 (the server's `score`), since "#14 Family" says little.
  const TOP_PLACES = 3;

  class Rank {
    static get TIERS() { return TIERS; }

    /**
     * How a rank reads wherever it is shown.
     * @param {{position:number, score:number, category_label:string}} entry
     * @returns {{top:boolean, num:string, rest:string, aria:string}}
     *   `num` is the emphasised part ("#2" / "7.4"), `rest` follows it
     *   (" Family" / "/10").
     */
    static badge(entry) {
      if (entry.position <= TOP_PLACES) {
        return {
          top: true, num: `#${entry.position}`, rest: ` ${entry.category_label}`,
          aria: `Number ${entry.position} of your ${entry.category_label} games`,
        };
      }
      const score = Number(entry.score).toFixed(1);
      return {
        top: false, num: score, rest: "/10",
        aria: `Rated ${score} out of 10 among your ${entry.category_label} games`,
      };
    }

    /** @returns {Promise<Object<string, {game_id:string, category:string, category_label:string, tier:string, position:number, score:number}>>} */
    static async summary({ force = false } = {}) {
      if (force) window.bgbCache.delete(NS, SUMMARY_KEY);
      const data = await window.bgbCache.swr(NS, SUMMARY_KEY,
        () => window.api.get("/ranks"),
        { freshTtl: FRESH_TTL_MS, staleTtl: STALE_TTL_MS });
      return _byGame(data);
    }

    /** Synchronous peek for a first-frame paint; null when nothing is cached.
     *  The pages that show ranks paint from this and fetch AFTER their own
     *  data, so the ranking never holds up the screen it decorates. */
    static cachedSummary() {
      const data = window.bgbCache.peek(NS, SUMMARY_KEY);
      return data ? _byGame(data) : null;
    }

    static cachedQueue() {
      const data = window.bgbCache.peek(NS, QUEUE_KEY);
      return data ? data.items || [] : null;
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
