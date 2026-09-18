// views/admin-backfill-view.js — the catalog-backfill spoke.
//
// ONE class, ONE instance, TWO panels: images and everything else. The tools
// are identical in shape — list what's missing, fix one row, fix them all — so
// they are a parameter, not two screens (ui-object-design.md §2), and since the
// parameter is the only thing that differs they are not two SPOKES either:
// "Missing images" and "Missing BGG data" are not two errands, they are one
// errand ("the catalog is short some BGG data") filed under two nouns, and
// Settings was once carrying four rows to say it.
//
// IT WAS FOUR PANELS. Descriptions, BGG stats and publishers each had a queue,
// an endpoint and a panel, and all three asked BoardGameGeek the same question:
// one /thing?stats=1 response carries the blurb, the stats, the publisher links
// AND the year. Three panels over one document is three sweeps of the catalog
// and a badge that counted a game twice for being short of two fields.
//
// Images stays separate because it is genuinely different work — one BGG call
// plus two downloads and two uploads per game, which is why its pass is a tenth
// the size (domain/admin-run-tools.js).
//
// This is NOT a return to the old combined /admin screen. That one was reached
// through a row labelled "Chapter reports", so the backfills were unreachable
// by name and one badge had to stand in for three queues. Here the row says
// what the screen holds and the badge counts what is behind it.
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
        oneOkToast: "Image refreshed",
        rowStatus: (g) => {
          const missing = [];
          if (!g.thumbnail_url) missing.push("thumb");
          if (!g.image_url) missing.push("image");
          return missing.length ? `Missing: ${missing.join(", ")}` : "OK";
        },
        list: () => window.Game.adminMissingImages(),
        refreshOne: (id) => window.Game.adminRefreshOneImage(id),
      },
      {
        key: "metadata",
        runTool: "bgg-metadata",
        title: "Games missing BGG data",
        icon: "layers",
        emptyText: "Every catalog game has been checked against BoardGameGeek.",
        oneOkToast: "Game data refreshed",
        // The server sends `missing` (the field names) and `checked_at`, so
        // this needs no ternaries and — more importantly — a row that has been
        // asked about says so. A game BoardGameGeek has nothing more to give
        // stays listed on purpose; without the "checked" half it reads as a
        // queue that will not drain.
        rowStatus: (g) => {
          const names = {
            description: "no description", stats: "no BGG stats",
            publishers: "no publisher", year: "no year",
          };
          const missing = (g.missing || []).map((k) => names[k] || k).join(", ");
          return g.checked_at
            ? `${missing} — BoardGameGeek has no more`
            : missing || "Not synced";
        },
        list: () => window.Game.adminMissingMetadata(),
        refreshOne: (id) => window.Game.adminRefreshOneMetadata(id),
      },
    ],
  });

  window.AdminBackfillView = AdminBackfillView;
})();
