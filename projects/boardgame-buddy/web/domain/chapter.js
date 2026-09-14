// domain/chapter.js — reference-guide chapter API wrappers.
//
// Each user builds their own per-game guide by adding chapters. Two
// flows: create new, or browse the per-game pool (sorted by popularity)
// and add an existing one.

(function () {
  // ── Reference-guide chapter cache ───────────────────────────────────────
  // The user's per-game guide doesn't change mid-session, so we cache it in
  // bgbCache (localStorage, bound per-user at auth). The widget seeds from
  // this for an instant paint, then revalidates; selecting a game for a play
  // warms it in the background so opening the guide on the Play screen or the
  // game-detail page is instant. Mutations clear the namespace so a just-edited
  // guide is never served stale.
  const CHAPTERS_NS = "chapters";
  // The scoring-grid chapters that EXIST for a game, adopted or not (migration
  // 018). A separate namespace from the guide above because it answers a
  // different question — "what is out there" rather than "what is mine" — and
  // is read by the scroll's "templates available" notice.
  const TEMPLATES_NS = "scoring-templates";
  // How many chapters EXIST for a game, adopted or not — the denominator of the
  // scroll's "3 of 12" button. Its own namespace for the same reason as
  // TEMPLATES_NS: it answers "what is out there", not "what is mine", and it is
  // a single integer rather than a row list.
  const POOL_COUNT_NS = "chapter-pool-count";
  const CH_FRESH = 10 * 60 * 1000; // instant-seed (get) window
  const CH_STALE = 30 * 60 * 1000; // outer bound retained in storage

  // Which scoring-grid chapter ids this viewer has already turned down, per
  // game: { "<gameId>": ["<chapterId>", …] }.
  //
  // ONE store, two surfaces. The reference-guide scroll's "templates
  // available" notice owned this privately until the play cascade grew an
  // offer of its own (views/play-flow-view.js#_maybeOfferTemplates) — and two
  // stores would have meant answering the same question twice: dismiss the
  // notice in the guide, then get asked again at the table two taps later.
  // Turning a grid down is turning it down, wherever the viewer was standing.
  //
  // Every access is wrapped, the way RoundGridSign / RoundGridNames wrap
  // theirs — a browser that refuses localStorage should show the offer every
  // time, not throw on the way to painting the guide.
  const DISMISS_KEY = "bgb.guide.tmplNotice";

  function readDismissed() {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (_) { return {}; }
  }

  function writeDismissed(map) {
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function chaptersKey(baseGameId, expansionIds) {
    const exp = (expansionIds || []).slice().sort().join(",");
    return exp ? `${baseGameId}|${exp}` : `${baseGameId}`;
  }

  const Chapter = {
    types() {
      return window.api.get("/chapter-types");
    },
    myChapters(gameId, { expansionIds } = {}) {
      const query = {};
      if (expansionIds && expansionIds.length) {
        query.expansion_ids = expansionIds.join(",");
      }
      return window.api.get(`/games/${gameId}/my-chapters`, query);
    },

    // Synchronous read of a cached my-chapters list (or null when absent/stale).
    //
    /**
     * Synchronous read of a cached guide.
     *
     * `stale: true` reads the full 7d window (peek) rather than the 24h fresh
     * one (get). A READER always wants it: chapters change rarely, the
     * request that would refresh them is already on its way, and the
     * alternative on a dead link is an empty reference scroll at exactly the
     * table where nobody can look the rules up any other way. A FRESHNESS
     * CHECK — prefetchMyChapters deciding whether to warm — must not, or a
     * stale entry would look like a reason to skip the refresh that would
     * replace it.
     *
     * This used to branch on connectivity, which conflated the two: it made
     * the freshness check stricter online than off for no reason, and tied a
     * caching policy to a latch that could be stale.
     *
     * @param {string} baseGameId
     * @param {string[]} [expansionIds]
     * @param {{stale?: boolean}} [opts]
     */
    cachedMyChapters(baseGameId, expansionIds, opts) {
      if (!window.bgbCache || !baseGameId) return null;
      const key = chaptersKey(baseGameId, expansionIds);
      return (opts && opts.stale)
        ? window.bgbCache.peek(CHAPTERS_NS, key)
        : window.bgbCache.get(CHAPTERS_NS, key);
    },
    // Write-through a freshly-fetched list.
    cacheMyChapters(baseGameId, expansionIds, rows) {
      if (!window.bgbCache || !baseGameId) return;
      window.bgbCache.setWithTtls(CHAPTERS_NS, chaptersKey(baseGameId, expansionIds), rows || [], {
        freshTtl: CH_FRESH,
        staleTtl: CH_STALE,
      });
    },
    // Fire-and-forget warm-up: skip when already fresh, otherwise fetch + cache.
    prefetchMyChapters(baseGameId, expansionIds = []) {
      if (!baseGameId || !window.session || !window.bgbCache) return;
      // No connectivity pre-check: api.js rejects instantly when the link is
      // known dead, so a warm that can't land costs a microtask and a .catch()
      // rather than a round trip. Readers fall back to the stale window.
      if (this.cachedMyChapters(baseGameId, expansionIds)) return;
      this.myChapters(baseGameId, { expansionIds })
        .then((rows) => this.cacheMyChapters(baseGameId, expansionIds, rows || []))
        .catch(() => {});
    },
    // Drop every cached guide. Called after any chapter mutation so the next
    // open refetches rather than serving the pre-mutation list.
    invalidateChaptersCache() {
      if (window.bgbCache) {
        window.bgbCache.clear(CHAPTERS_NS);
        // Adding a template is what makes the notice go away, so its cache has
        // to fall with the guide's or the notice outlives the tap that answered
        // it by up to ten minutes.
        window.bgbCache.clear(TEMPLATES_NS);
        // Writing a chapter grows the pool, so the denominator falls with the
        // guide's cache too — otherwise the button says "1 of 0" for up to ten
        // minutes after somebody writes the first one for a game.
        window.bgbCache.clear(POOL_COUNT_NS);
      }
      // Three tiers of "chapters in your guide" hang off this count, so every
      // chapter mutation is an achievement mutation too.
      if (window.Achievements && window.Achievements.invalidate) window.Achievements.invalidate();
    },
    pool(gameId, { q, chapterType, layout, expansionIds } = {}) {
      const query = {};
      if (q) query.q = q;
      if (chapterType) query.chapter_type = chapterType;
      if (layout) query.layout = layout;
      if (expansionIds && expansionIds.length) {
        query.expansion_ids = expansionIds.join(",");
      }
      return window.api.get(`/games/${gameId}/chapter-pool`, query);
    },

    // ── Scoring templates (migration 018) ───────────────────────────────────
    //
    // The pool already answers "does this game have scoring templates I haven't
    // added?" — every row carries in_my_guide — so this is the pool with one
    // filter, not a second endpoint. Same cache discipline as the guide above,
    // in its own namespace.

    scoringTemplates(gameId, { expansionIds } = {}) {
      return this.pool(gameId, {
        chapterType: "scoring_grid",
        layout: "scoring_grid",
        expansionIds,
      });
    },
    // Synchronous read. `stale: true` reads the full window rather than the
    // fresh one — same split, and same reason, as cachedMyChapters above.
    cachedScoringTemplates(baseGameId, expansionIds, opts) {
      if (!window.bgbCache || !baseGameId) return null;
      const key = chaptersKey(baseGameId, expansionIds);
      return (opts && opts.stale)
        ? window.bgbCache.peek(TEMPLATES_NS, key)
        : window.bgbCache.get(TEMPLATES_NS, key);
    },
    cacheScoringTemplates(baseGameId, expansionIds, rows) {
      if (!window.bgbCache || !baseGameId) return;
      window.bgbCache.setWithTtls(TEMPLATES_NS, chaptersKey(baseGameId, expansionIds), rows || [], {
        freshTtl: CH_FRESH,
        staleTtl: CH_STALE,
      });
    },

    // ── Pool size ───────────────────────────────────────────────────────────
    //
    // Just the count of `pool()` above, fetched separately rather than derived
    // from it: the pool's rows each carry a full markdown body, and the guide
    // wants this number on every mount to say how much of what exists the
    // viewer keeps.

    poolCount(gameId, { expansionIds } = {}) {
      const query = {};
      if (expansionIds && expansionIds.length) {
        query.expansion_ids = expansionIds.join(",");
      }
      return window.api
        .get(`/games/${gameId}/chapter-pool/count`, query)
        .then((res) => (res && typeof res.total === "number" ? res.total : 0));
    },
    // Synchronous read. `stale: true` reads the full window rather than the
    // fresh one — same split, and same reason, as cachedMyChapters above.
    cachedPoolCount(baseGameId, expansionIds, opts) {
      if (!window.bgbCache || !baseGameId) return null;
      const key = chaptersKey(baseGameId, expansionIds);
      const hit = (opts && opts.stale)
        ? window.bgbCache.peek(POOL_COUNT_NS, key)
        : window.bgbCache.get(POOL_COUNT_NS, key);
      // A cached 0 is an answer ("nobody has written one") and must survive the
      // read, so test the type rather than truthiness.
      return typeof hit === "number" ? hit : null;
    },
    cachePoolCount(baseGameId, expansionIds, total) {
      if (!window.bgbCache || !baseGameId) return;
      window.bgbCache.setWithTtls(POOL_COUNT_NS, chaptersKey(baseGameId, expansionIds), total || 0, {
        freshTtl: CH_FRESH,
        staleTtl: CH_STALE,
      });
    },

    /**
     * The templates worth offering: the ones this viewer has not adopted,
     * minus the ones they have said no to — in either of the two ways there
     * are to say it.
     *
     * TWO refusals, and they are not the same refusal. `disliked` is the
     * durable, server-side one (migration 033): the viewer has turned the grid
     * down for good, on every device, and it is also gone from their pool and
     * their chapter count. The localStorage list below is the soft one: "not
     * now", per device, and only ever about this offer. A grid needs to clear
     * both to be worth putting in front of somebody.
     *
     * Disliked rows reach this function at all because the chapter pool ships
     * them TAGGED rather than dropping them — the guide builder needs them for
     * its Turned-down section. So the filter belongs here, in the one function
     * both offer surfaces already go through (the guide's notice via
     * widgets/reference-guide-scroll.js#_pendingTemplates, and the play
     * cascade via views/play-flow-view.js#_maybeOfferTemplates), rather than
     * in each of them.
     *
     * @param {Array<any>} rows a chapter-pool response
     * @param {string} gameId the BASE game the pool was fetched for — the same
     *   key dismissTemplates writes under, so an expansion's grid is turned
     *   down against the game it was offered beside, not against itself.
     */
    pendingTemplates(rows, gameId) {
      const unowned = (rows || []).filter((t) => !t.in_my_guide && !t.disliked);
      if (!unowned.length) return [];
      const seen = readDismissed()[gameId] || [];
      return unowned.filter((t) => seen.indexOf(t.id) < 0);
    },

    /**
     * Turn down the templates named by `ids`, by id — not with a boolean. A
     * game that gets a new scoring grid published next month should be able to
     * ask once more, and a boolean could never tell that apart from the ones
     * already declined.
     */
    dismissTemplates(gameId, ids) {
      if (!gameId || !ids || !ids.length) return;
      const all = readDismissed();
      const prev = all[gameId] || [];
      all[gameId] = prev.concat(ids.filter((id) => prev.indexOf(id) < 0));
      writeDismissed(all);
    },
    create(gameId, payload) {
      return window.api.post(`/games/${gameId}/chapters`, payload);
    },
    // AI-draft a chapter of `chapterType` for this game. Returns
    // { chapter_type, title, content } — a draft for the editor to load into
    // its form. Saves nothing; the user reviews and hits Save themselves.
    // Slower than every other call here (a live LLM round-trip), so callers
    // must show a pending state.
    //
    // `prompt` is the optional free-text steer from the wizard's head-start
    // step ("just the endgame trigger"). Sent only when it has content — the
    // backend caps it at 500 chars and 422s past that, and an empty string
    // would be indistinguishable from "no steer" on the wire.
    generate(gameId, chapterType, prompt) {
      const body = { chapter_type: chapterType };
      const focus = (prompt || "").trim();
      if (focus) body.prompt = focus;
      return window.api.post(`/games/${gameId}/chapters/generate`, body);
    },
    // AI-draft the ROWS of a scoring grid for this game. Returns
    // { grid: { v, rows: [{label, color, note?}] } } — the same shape create()
    // takes, so the wizard can load it into the row editor and post it back
    // unedited if the author likes it as it stands.
    //
    // A separate endpoint from generate() above rather than a branch inside it:
    // a grid has no markdown in it, so the two calls share neither a prompt nor
    // a reply shape, and generate() 400s a scoring_grid chapter_type outright.
    // No chapter type on the wire at all — a grid is one type by definition.
    //
    // `mode` is the add_on / replace choice for an EXPANSION's grid (migration
    // 032), and unlike `prompt` it changes WHAT is drafted rather than steering
    // it: an add-on wants the rows the box brings, a replacement wants the whole
    // reprinted sheet. Sent unconditionally, exactly as create() sends it — the
    // backend re-resolves it against the game (it is the only side that knows
    // authoritatively whether that game is an expansion) and ignores it for a
    // base game, so a client that guesses wrong cannot mis-shape the draft.
    //
    // Same pending-state obligation as generate(): it is a live LLM round trip.
    generateGrid(gameId, prompt, mode) {
      const body = {};
      const focus = (prompt || "").trim();
      if (focus) body.prompt = focus;
      if (mode) body.mode = mode;
      return window.api.post(`/games/${gameId}/chapters/generate-grid`, body);
    },
    add(gameId, chapterId) {
      return window.api.post(`/games/${gameId}/my-chapters`, { chapter_id: chapterId });
    },
    remove(gameId, chapterId) {
      return window.api.del(`/games/${gameId}/my-chapters/${chapterId}`);
    },

    // ── Dislikes (migration 033) ────────────────────────────────────────────
    //
    // The inverse of add/remove above, and NOT the same thing as
    // dismissTemplates() further up this file. A dismissal is a per-device
    // "not now" that suppresses one offer sheet; a dislike is a per-USER,
    // server-side "stop recommending this", which takes the chapter out of the
    // pool, off the guide's "N of M" denominator and out of the template offer
    // on every device the user signs in on. Both exist because they answer
    // different questions, and neither reads the other's store.
    //
    // Disliking a chapter the user had added drops it from their guide in the
    // same write — one row, one state — so a caller must treat a dislike as a
    // potential removal and invalidate accordingly.
    dislike(gameId, chapterId) {
      return window.api.post(`/games/${gameId}/disliked-chapters`, { chapter_id: chapterId });
    },
    // Undo. Deliberately does NOT re-add: taking back a dislike puts the
    // chapter back in the pool where it can be considered again, which is a
    // different act from adopting it.
    undislike(gameId, chapterId) {
      return window.api.del(`/games/${gameId}/disliked-chapters/${chapterId}`);
    },
    update(chapterId, payload) {
      return window.api.patch(`/chapters/${chapterId}`, payload);
    },
    delete(chapterId) {
      return window.api.del(`/chapters/${chapterId}`);
    },
    report(chapterId, reason) {
      return window.api.post(`/chapters/${chapterId}/report`, { reason: reason || null });
    },
    adminReports(status) {
      return window.api.get("/admin/chapter-reports", { status: status || "open" });
    },
    adminResolveReport(reportId) {
      return window.api.post(`/admin/chapter-reports/${reportId}/resolve`);
    },
  };

  window.Chapter = Chapter;
})();
