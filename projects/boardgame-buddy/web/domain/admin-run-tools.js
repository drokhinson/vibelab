// @ts-check
// domain/admin-run-tools.js — what the three admin catalog runs ARE, and what
// they say.
//
// Split from domain/admin-run-flow.js, which is the machine: this file holds
// no state and starts nothing. The seam is the one the rest of the app already
// uses — a view's strings live with the view (AdminBackfillView.bggData()),
// and init.js stays a registry of what exists rather than a description of
// what each thing says — applied one level down, because three surfaces read
// this table and none of them owns it.
//
// Every sentence a reader sees on an admin run page is here. The flow next
// door knows only slugs, passes and `remaining`.

(function () {
  /**
   * The three tools, in one table read by all three surfaces.
   *
   * It lives here rather than in init.js for the same reason
   * AdminBackfillView.bggData() keeps its strings with its view: init.js is a
   * registry of what exists, not a description of what each thing says.
   *
   * `limit` and `timeoutMs` go together and are a pair of guesses about the
   * same thing — how long one pass takes. A pass has to fit inside the browser
   * deadline below it AND inside the platform's request timeout, so the slower
   * the per-game work, the smaller the bite. Images are by far the slowest
   * (one BGG call plus two downloads and two uploads each, spaced 1.5s), which
   * is why their bite is a tenth of the other's.
   *
   * There were five. Descriptions, stats and publishers were three tools
   * asking BoardGameGeek the SAME question — one /thing?stats=1 response
   * carries the blurb, the stats, the publisher links and the year — so they
   * walked the catalog three times to read one document. Images stays its own
   * tool because it is genuinely different work.
   */
  const TOOLS = {
    trending: {
      title: "Refresh trending",
      lede: "Snapshot the BGG hot list; import new games.",
      icon: "flame",
      multiPass: false,
      timeoutMs: 180 * 1000,
      order: ["fetch", "snapshot", "prune", "diff", "import", "caches"],
      labels: {
        fetch: "Read hot list",
        snapshot: "Save snapshot",
        prune: "Prune old runs",
        diff: "Diff catalog",
        import: "Import new games",
        caches: "Refresh Discover",
      },
      run: (opts) => window.Game.adminRefreshTrending(opts),
    },
    "bgg-images": {
      title: "Missing images",
      lede: "Re-host box art that is missing or hotlinked to BGG.",
      icon: "image-off",
      multiPass: true,
      limit: 25,
      timeoutMs: 5 * 60 * 1000,
      run: (opts) => window.Game.adminRefreshAllImages(opts),
    },
    "bgg-metadata": {
      title: "Missing BGG data",
      lede: "Fetch description, publishers, stats and year — one BGG call per game.",
      icon: "layers",
      multiPass: true,
      limit: 200,
      timeoutMs: 5 * 60 * 1000,
      run: (opts) => window.Game.adminBackfillMetadata(opts),
    },
    // Records links only — no downloads — so it takes the metadata tool's bite.
    "bgg-image-links": {
      title: "BGG image links",
      lede: "Save BGG image URLs beside our hosted copies. One call per 20 games.",
      icon: "link",
      multiPass: true,
      limit: 200,
      timeoutMs: 5 * 60 * 1000,
      run: (opts) => window.Game.adminBackfillImageLinks(opts),
    },
  };

  // The backfills share one phase vocabulary, because they are one job with a
  // different noun in it — the same argument views/admin-backfill-view.js
  // makes for their being one screen.
  const BACKFILL_ORDER = ["scan", "fetch", "caches"];
  const BACKFILL_LABELS = {
    scan: "Find gaps",
    fetch: "Fetch from BGG",
    caches: "Refresh caches",
  };


  window.AdminRunTools = {
    /** @param {string} slug */
    get(slug) {
      const t = TOOLS[slug];
      if (!t) return null;
      return {
        slug,
        ...t,
        order: t.order || BACKFILL_ORDER,
        labels: t.labels || BACKFILL_LABELS,
      };
    },
    slugs() { return Object.keys(TOOLS); },
  };
})();
