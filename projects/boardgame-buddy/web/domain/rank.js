// domain/rank.js — the viewer's game ranking (migration 056).
//
// A game is ranked against the other games in ITS category, which the server
// decides from BoardGameGeek's family lists — the client never picks one. Three
// reads, one write (DELETE /ranks/games/{id} exists; nothing here offers it yet):
//
//   summary()  every ranked game's place and score, held whole (tens of rows). The
//              game page pill and the Collection top-5 chips read it.
//   queue()    played games with no rank yet, A to Z, then the ones parked
//              with "Rank after next play" (`deferred`, migration 058), A to Z.
//              countable() is the part that counts toward "N unranked".
//   context()  one game's category, current rank, and the list it is ranked
//              against. localContext() builds the same thing from the cached
//              summary (whose entries carry their game), so the sheet and the
//              queue only fetch it when the cache cannot answer.
//   place()    write a tier + index; the echo carries the whole ranking, which
//              REPLACES the cached summary (and the game leaves the cached
//              queue), then `ranks-changed` fires — so every surface repaints
//              from cache and nothing refetches.
//   defer()    park an unranked game until its next play: flags it in the
//              cached queue first, then writes. The server lapses the flag by
//              itself once the game is played, which the queue sees because a
//              saved play drops it (invalidateQueue()).
//
// Both reads are seeded at boot from /bootstrap (seed()), so they are cache
// hits from the first screen. That, and place() writing the cache itself, is
// why the TTLs are long: the only things that change a ranking are this
// viewer's own writes, and the queue is dropped (invalidateQueue()) whenever a
// play or a played-before mark changes what counts as played.

(function () {
  const NS = "rank";
  const SUMMARY_KEY = "summary";
  const QUEUE_KEY = "queue";
  const TTLS = {
    [SUMMARY_KEY]: { freshTtl: 30 * 60 * 1000, staleTtl: 24 * 60 * 60 * 1000 },
    [QUEUE_KEY]: { freshTtl: 10 * 60 * 1000, staleTtl: 24 * 60 * 60 * 1000 },
  };

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

  function _changed(gameId, echo) {
    if (echo && Array.isArray(echo.ranks)) {
      window.bgbCache.setWithTtls(NS, SUMMARY_KEY, { ranks: echo.ranks }, TTLS[SUMMARY_KEY]);
      const queued = window.bgbCache.peek(NS, QUEUE_KEY);
      if (queued && Array.isArray(queued.items)) {
        window.bgbCache.setWithTtls(NS, QUEUE_KEY,
          { items: queued.items.filter((it) => !it.game || it.game.id !== gameId) },
          TTLS[QUEUE_KEY]);
      }
    } else {
      // A server from before the echo carried the ranking: refetch instead.
      window.bgbCache.delete(NS, SUMMARY_KEY);
      window.bgbCache.delete(NS, QUEUE_KEY);
    }
    document.dispatchEvent(new CustomEvent("ranks-changed", { detail: { gameId } }));
  }

  // Mirrors rank_service._SCORE_BANDS.
  const SCORE_BANDS = { love: [10.0, 7.0], good: [6.9, 4.0], not: [3.9, 1.0] };

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
        () => window.api.get("/ranks"), TTLS[SUMMARY_KEY]);
      return _byGame(data);
    }

    /**
     * The rating the server will give the game at `index` of `count` in its
     * tier — MUST match rank_service._score (api/routes/services), so the
     * result screen can show it before the save lands.
     */
    static scoreFor(tier, index, count) {
      const [hi, lo] = SCORE_BANDS[tier] || SCORE_BANDS.good;
      if (count <= 1) return hi;
      return Math.round((hi - (hi - lo) * index / (count - 1)) * 10) / 10;
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

    /** @returns {Promise<Array<{game:Object, category:string, category_label:string, deferred?:boolean}>>} */
    static async queue({ force = false } = {}) {
      if (force) window.bgbCache.delete(NS, QUEUE_KEY);
      const data = await window.bgbCache.swr(NS, QUEUE_KEY,
        () => window.api.get("/ranks/queue"), TTLS[QUEUE_KEY]);
      return (data && data.items) || [];
    }

    /** The queue items that count toward "N unranked": all but the deferred. */
    static countable(items) {
      return (items || []).filter((it) => !it.deferred);
    }

    /**
     * "Rank after next play". Optimistic: the cached queue flags the game and
     * re-sorts (deferred last, as the server orders it) and `ranks-changed`
     * fires before the request; a failure puts the queue back and rethrows.
     */
    static async defer(gameId) {
      const queued = window.bgbCache.peek(NS, QUEUE_KEY);
      const before = queued && Array.isArray(queued.items) ? queued.items : null;
      if (before) {
        const items = before.map((it) => (it.game && it.game.id === gameId ? { ...it, deferred: true } : it));
        const byName = (a, b) => String(a.game && a.game.name).localeCompare(String(b.game && b.game.name));
        items.sort((a, b) => (a.deferred ? 1 : 0) - (b.deferred ? 1 : 0) || byName(a, b));
        window.bgbCache.setWithTtls(NS, QUEUE_KEY, { items }, TTLS[QUEUE_KEY]);
      }
      const fire = () => document.dispatchEvent(new CustomEvent("ranks-changed", { detail: { gameId } }));
      fire();
      try {
        await window.api.put(`/ranks/games/${encodeURIComponent(gameId)}/defer`, {});
      } catch (err) {
        if (before) window.bgbCache.setWithTtls(NS, QUEUE_KEY, { items: before }, TTLS[QUEUE_KEY]);
        else window.bgbCache.delete(NS, QUEUE_KEY);
        fire();
        throw err;
      }
    }

    /** @param {{current?: boolean}} [opts] current: the list for the category
     *  the game belongs in NOW (a Re-rank), not the one it is stored in. */
    static context(gameId, { current = false } = {}) {
      return window.api.get(`/ranks/games/${encodeURIComponent(gameId)}${current ? "?current=true" : ""}`);
    }

    /** @param {{recategorize?: boolean}} [opts] recategorize: a Re-rank —
     *  place it in the category the rules give it now, leaving the old list. */
    static async place(gameId, tier, index, { recategorize = false } = {}) {
      const body = recategorize ? { tier, index, recategorize: true } : { tier, index };
      const entry = await window.api.put(`/ranks/games/${encodeURIComponent(gameId)}`, body);
      _changed(gameId, entry);
      return entry;
    }

    /**
     * Seed both reads from /bootstrap's `ranks` / `rank_queue` (null = that
     * read failed server-side; leave the key to its own fetch). A key written
     * after the boot request went out — a rank placed mid-boot — is newer than
     * the payload and is kept.
     */
    static seed({ ranks, queue }, { startedAt = 0 } = {}) {
      const put = (key, value) => {
        if (startedAt && window.bgbCache.storedAt(NS, key) > startedAt) return;
        window.bgbCache.setWithTtls(NS, key, value, TTLS[key]);
      };
      if (Array.isArray(ranks)) put(SUMMARY_KEY, { ranks });
      if (Array.isArray(queue)) put(QUEUE_KEY, { items: queue });
    }

    /**
     * The GET /ranks/games/{id} payload, built from the cached ranking instead
     * of asked for: {game, category, category_label, rank, ranked}. A game
     * already ranked keeps its stored category (as the server's _category_for
     * does); otherwise `cats` supplies it — the queue item, which the server
     * decided. Null when the cache cannot answer (no summary, no category, or
     * a summary cached before entries carried their game): fetch then.
     */
    static localContext(game, cats = {}, { current = false } = {}) {
      const summary = Rank.cachedSummary();
      if (!summary || !game || !game.id) return null;
      const own = summary[game.id] || null;
      // `current`: a Re-rank into the category the game belongs in now.
      const useOwn = own && !current;
      const category = useOwn ? own.category : cats.category;
      const label = useOwn ? own.category_label : cats.category_label;
      if (!category) return null;
      const others = Object.values(summary)
        .filter((e) => e.category === category && e.game_id !== game.id);
      if (others.some((e) => !e.game)) return null;
      others.sort((a, b) => a.position - b.position);
      return {
        game: own && own.game ? { ...own.game, ...game } : game,
        category,
        category_label: label || category,
        rank: own,
        ranked: others.map((e, i) => ({ game: e.game, tier: e.tier, position: i + 1 })),
      };
    }

    /** What counts as played changed (a play saved or deleted, a played-before
     *  mark): the queue has to be asked again. The ranking itself has not moved. */
    static invalidateQueue() {
      window.bgbCache.delete(NS, QUEUE_KEY);
    }
  }

  window.Rank = Rank;
})();
