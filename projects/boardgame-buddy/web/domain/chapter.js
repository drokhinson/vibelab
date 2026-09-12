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

    /**
     * The templates worth offering: the ones this viewer has not adopted,
     * minus the ones they have already turned down for this game.
     *
     * @param {Array<any>} rows a chapter-pool response
     * @param {string} gameId the BASE game the pool was fetched for — the same
     *   key dismissTemplates writes under, so an expansion's grid is turned
     *   down against the game it was offered beside, not against itself.
     */
    pendingTemplates(rows, gameId) {
      const unowned = (rows || []).filter((t) => !t.in_my_guide);
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
    add(gameId, chapterId) {
      return window.api.post(`/games/${gameId}/my-chapters`, { chapter_id: chapterId });
    },
    remove(gameId, chapterId) {
      return window.api.del(`/games/${gameId}/my-chapters/${chapterId}`);
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
