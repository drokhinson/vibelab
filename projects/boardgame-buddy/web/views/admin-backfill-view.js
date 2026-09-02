// views/admin-backfill-view.js — a catalog-backfill spoke.
//
// ONE class, TWO instances: "Games missing images" and "Games missing
// descriptions". The tools are identical in shape — list what's missing, fix
// one row, fix them all — so they are a parameter, not two screens
// (ui-object-design.md §2). All the behaviour lives in the AdminBackfillPanel
// widget; this view is the route, the header, and the count refresh.

(function () {
  class AdminBackfillView extends window.View {
    /**
     * @param {Object} opts
     * @param {string} opts.route  route name, also this view's data-view container
     * @param {string} opts.title  spoke header
     * @param {string} opts.global the `window.<name>` this instance is exposed as,
     *                             so the panel's inline onclick handlers can reach it
     * @param {Object} opts.panel  AdminBackfillPanel config, minus `render`
     */
    constructor(opts) {
      super(opts.route);
      this.opts = opts;
      this.panel = new window.AdminBackfillPanel({
        ...opts.panel,
        host: opts.global,
        render: () => this.render(),
      });
    }

    async onMount() {
      if (!window.AdminGate.allowed()) return;
      await this.panel.load();
    }

    render() {
      // Re-checked on every paint, not once in onMount: View#mount()
      // renders again after onMount, which would overwrite a one-shot refusal.
      if (window.AdminGate.block(this)) return;
      this.container.innerHTML = `
        ${window.AdminGate.head(this.opts.title)}
        <section class="admin-spoke__body">${this.panel.html()}</section>
      `;
      this.refreshIcons();
    }

    // Delegators for the panel's inline onclick handlers. The panel renders
    // markup into this view's container, so `window.<global>` is the stable
    // handle those attributes can name.
    _one(gameId) {
      return this.panel.refreshOne(gameId).then(() => window.AdminReview.refresh());
    }

    _all() {
      return this.panel.refreshAll().then(() => window.AdminReview.refresh());
    }
  }

  // The two configured instances. Their strings live here, with the view that
  // renders them, rather than in init.js — which stays a registry of what
  // exists, not a description of what each screen says.
  AdminBackfillView.images = () => new AdminBackfillView({
    route: "admin-images",
    title: "Missing images",
    global: "adminImagesView",
    panel: {
      key: "images",
      title: "Games missing images",
      icon: "image-off",
      emptyText: "All catalog games have images.",
      bulkLabel: "Refresh all",
      busyLabel: "Refreshing\u2026",
      oneOkToast: "Image refreshed",
      rowStatus: (g) => {
        const missing = [];
        if (!g.thumbnail_url) missing.push("thumb");
        if (!g.image_url) missing.push("image");
        return missing.length ? `Missing: ${missing.join(", ")}` : "OK";
      },
      bulkConfirm: (n) => (n > 0
        ? `Re-host BGG images for ${n} game${n === 1 ? "" : "s"}? This calls BGG once per game and is throttled \u2014 may take a minute or two.`
        : "Re-host images for every game with a missing or BGG-hosted URL? This calls BGG once per game and is throttled."),
      list: () => window.Game.adminMissingImages(),
      refreshOne: (id) => window.Game.adminRefreshOneImage(id),
      refreshAll: () => window.Game.adminRefreshAllImages(),
    },
  });

  AdminBackfillView.descriptions = () => new AdminBackfillView({
    route: "admin-descriptions",
    title: "Missing descriptions",
    global: "adminDescriptionsView",
    panel: {
      key: "descriptions",
      title: "Games missing descriptions",
      icon: "scroll-text",
      emptyText: "Every catalog game has a description.",
      bulkLabel: "Backfill all",
      busyLabel: "Backfilling\u2026",
      oneOkToast: "Description refreshed",
      rowStatus: () => "No description",
      bulkConfirm: (n) => (n > 0
        ? `Fetch BGG descriptions for ${n} game${n === 1 ? "" : "s"}? BGG is called in batches of 20 and the run continues automatically until every game is done \u2014 may take a minute or two.`
        : "Fetch BGG descriptions for every game that has none? BGG is called in batches of 20."),
      list: () => window.Game.adminMissingDescriptions(),
      refreshOne: (id) => window.Game.adminRefreshOneDescription(id),
      refreshAll: () => window.Game.adminBackfillDescriptions(),
    },
  });

  window.AdminBackfillView = AdminBackfillView;
})();
