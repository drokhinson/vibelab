// views/admin-backfill-view.js — the catalog-backfill spoke.
//
// ONE class, ONE instance, FOUR panels: images, descriptions, BGG stats and
// publishers. The tools are identical in shape — list what's missing, fix one
// row, fix them all — so they are a parameter, not four screens
// (ui-object-design.md §2), and since the parameter is the only thing that
// differs they are also not four SPOKES: "Missing images" and "Missing
// publishers" are not two errands, they are one errand ("the catalog is short
// some BGG data") filed under two nouns, and Settings was carrying four rows
// to say it.
//
// This is NOT a return to the old combined /admin screen. That one was reached
// through a row labelled "Chapter reports", so the backfills were unreachable
// by name and one badge had to stand in for three queues. Here the row says
// what the screen holds, the badge sums the queues behind it and its
// aria-label still names them one by one.
//
// All the behaviour lives in the AdminBackfillPanel widget; this view is the
// route, the header, and the count refresh.

(function () {
  class AdminBackfillView extends window.View {
    /**
     * @param {Object} opts
     * @param {string} opts.route  route name, also this view's data-view container
     * @param {string} opts.title  spoke header
     * @param {string} opts.global the `window.<name>` this instance is exposed as,
     *                             so the panels' inline onclick handlers can reach it
     * @param {Object[]} opts.panels  AdminBackfillPanel configs, minus `render`/`host`
     */
    constructor(opts) {
      super(opts.route);
      this.opts = opts;
      this.panels = opts.panels.map((cfg) => new window.AdminBackfillPanel({
        ...cfg,
        host: opts.global,
        render: () => this.render(),
      }));
    }

    async onMount() {
      if (!window.AdminGate.allowed()) return;
      // The four bulk buttons report their runs, and a run outlives this
      // screen — so this repaints on the flow's ticks and adopts whatever is
      // already going, the same way the Settings card does.
      this.listen("adminRun", () => this.render());
      this.listenDom("visibilitychange", () => {
        if (!document.hidden && window.AdminRunFlow) window.AdminRunFlow.catchUp();
      });
      window.AdminRunFlow.adopt();
      // In parallel: four independent "what's missing" queries with no ordering
      // between them, and serialising them would leave the last panel spinning
      // behind three others for no reason. Each panel paints itself as it
      // lands — load() calls render() on both edges.
      await Promise.all(this.panels.map((p) => p.load()));
    }

    render() {
      // Re-checked on every paint, not once in onMount: View#mount()
      // renders again after onMount, which would overwrite a one-shot refusal.
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head(this.opts.title)}
        ${this.panels.map((p) => `
          <section class="admin-spoke__body">${p.html()}</section>
        `).join("")}
      `;
      this.refreshIcons();
    }

    /** The panel a delegated tap belongs to, by the key its markup carried. */
    _panel(key) {
      return this.panels.find((p) => p.key === key);
    }

    // Delegators for the panels' inline onclick handlers. The panels render
    // markup into this view's container, so `window.<global>` is the stable
    // handle those attributes can name, and `key` is how one handle serves
    // four panels.
    _one(key, gameId) {
      const panel = this._panel(key);
      if (!panel) return Promise.resolve();
      return panel.refreshOne(gameId).then(() => window.AdminReview.refresh());
    }

    /** The bulk button. It no longer runs anything here — it confirms and
     *  hands off to /admin/run/:tool, which owns the drain and the log. The
     *  counts are refreshed on the way back in by onMount, not here: there is
     *  nothing to refresh yet at the moment of the tap. */
    _all(key) {
      const panel = this._panel(key);
      if (!panel) return Promise.resolve();
      return panel.goToRun();
    }
  }

  // The configured instance. Its strings live here, with the view that renders
  // them, rather than in init.js — which stays a registry of what exists, not a
  // description of what each screen says.
  AdminBackfillView.bggData = () => new AdminBackfillView({
    route: "admin-bgg-data",
    title: "Missing BGG data",
    global: "adminBggDataView",
    panels: [
      {
        key: "images",
        runTool: "bgg-images",
        title: "Games missing images",
        icon: "image-off",
        emptyText: "All catalog games have images.",
        bulkLabel: "Refresh all",
        oneOkToast: "Image refreshed",
        rowStatus: (g) => {
          const missing = [];
          if (!g.thumbnail_url) missing.push("thumb");
          if (!g.image_url) missing.push("image");
          return missing.length ? `Missing: ${missing.join(", ")}` : "OK";
        },
        bulkConfirm: (n) => (n > 0
          ? `Re-host BGG images for ${n} game${n === 1 ? "" : "s"}? One throttled BGG call per game, so a cold catalog takes a while. You'll watch it on the run page and can leave it going.`
          : "Re-host images for every game with a missing or BGG-hosted URL? One throttled BGG call per game. You'll watch it on the run page and can leave it going."),
        list: () => window.Game.adminMissingImages(),
        refreshOne: (id) => window.Game.adminRefreshOneImage(id),
      },
      {
        key: "descriptions",
        runTool: "bgg-descriptions",
        title: "Games missing descriptions",
        icon: "scroll-text",
        emptyText: "Every catalog game has a description.",
        bulkLabel: "Backfill all",
        oneOkToast: "Description refreshed",
        rowStatus: () => "No description",
        bulkConfirm: (n) => (n > 0
          ? `Fetch BGG descriptions for ${n} game${n === 1 ? "" : "s"}? BGG is called in batches of 20 until every game is done. You'll watch it on the run page and can leave it going.`
          : "Fetch BGG descriptions for every game that has none? BGG is called in batches of 20. You'll watch it on the run page and can leave it going."),
        list: () => window.Game.adminMissingDescriptions(),
        refreshOne: (id) => window.Game.adminRefreshOneDescription(id),
      },
      {
        key: "stats",
        runTool: "bgg-stats",
        title: "Games missing BGG stats",
        icon: "star",
        emptyText: "Every catalog game has its BGG rating and rank.",
        bulkLabel: "Sync all",
        oneOkToast: "Stats refreshed",
        rowStatus: () => "Not synced",
        bulkConfirm: (n) => (n > 0
          ? `Fetch BGG ratings, ranks and weights for ${n} game${n === 1 ? "" : "s"}? Throttled batches of 20 until every game is done — a cold catalog takes a few minutes. You'll watch it on the run page and can leave it going.`
          : "Fetch BGG stats for every game that has none? Throttled batches of 20. You'll watch it on the run page and can leave it going."),
        list: () => window.Game.adminMissingStats(),
        refreshOne: (id) => window.Game.adminRefreshOneStats(id),
      },
      {
        key: "publishers",
        runTool: "bgg-publishers",
        title: "Games missing publishers",
        icon: "library-big",
        emptyText: "Every catalog game has been checked for a publisher.",
        bulkLabel: "Backfill all",
        oneOkToast: "Publishers refreshed",
        rowStatus: () => "Not synced",
        bulkConfirm: (n) => (n > 0
          ? `Fetch BGG publisher credits for ${n} game${n === 1 ? "" : "s"}? Throttled batches of 20 until every game is done — a cold catalog takes a few minutes. You'll watch it on the run page and can leave it going.`
          : "Fetch BGG publisher credits for every game that has none? Throttled batches of 20. You'll watch it on the run page and can leave it going."),
        list: () => window.Game.adminMissingPublishers(),
        refreshOne: (id) => window.Game.adminRefreshOnePublishers(id),
      },
    ],
  });

  window.AdminBackfillView = AdminBackfillView;
})();
