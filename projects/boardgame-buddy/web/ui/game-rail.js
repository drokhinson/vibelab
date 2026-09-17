// ui/game-rail.js — a horizontal rail of Game tiles under a titled header.
//
// Extracted from views/feed-view.js the day the Discover tab became its
// second consumer (.claude/rules/ui-object-design.md §4: extract at instance
// #2). The feed's "Hot this week" rail and the four Discover rails are the
// same thing — a header with an icon, a scroll strip of `rail` polaroids — and
// the markup here is exactly what feed-view's private _renderGameRail emitted,
// so the `.feed-rail` CSS family did not move.
//
// Lifecycle-free: returns a string, binds nothing. Status pills are painted
// from the caller's status map on render and repainted by the caller on
// `status-changed` through window.syncGamePolaroidStatus, the one writer.
//
// Two kinds of entry:
//   { game, meta?, reason? }   a catalog game — the normal tile
//   { stub, meta? }            a game the catalog does not have (a BGG hot-list
//                              row). Rendered from the stub's own fields with no
//                              status pill; the tap goes to `stubHandler`.

(function () {
  /**
   * @typedef {Object} GameRailEntry
   * @property {any=} game       A GameSummary. Present unless `stub` is.
   * @property {{bgg_id:number, name:string, thumbnail_url?:string|null, year_published?:number|null}=} stub
   * @property {string=} meta    Overrides the tile's "3–5P · 60m" line.
   * @property {string=} reason  One-line caption under the name (Discover picks).
   */

  /**
   * @param {GameRailEntry[]} entries
   * @param {Object} opts
   * @param {string} opts.icon            data-icon name beside the title
   * @param {string} opts.title
   * @param {string=} opts.subtitle       muted line under the title
   * @param {Object} opts.statusMap       gameId → collection status
   * @param {boolean} opts.statusReady    false while the map is still loading
   * @param {Object=} opts.expansionCounts  base bgg_id → owned-expansion count
   * @param {(game:any)=>string} opts.clickHandler   raw JS for a catalog tile's tap
   * @param {(stub:any)=>string=} opts.stubHandler   raw JS for a stub tile's tap
   * @param {boolean=} opts.flush         `.feed-rail--flush`: the host pads its own gutters
   * @param {string=} opts.emptyHtml      rendered in place of the strip when there are no entries
   * @param {boolean=} opts.eager         load tile art eagerly (a rail that is above the fold)
   * @returns {string}
   */
  function renderGameRail(entries, opts) {
    const {
      icon, title, subtitle = "", statusMap = {}, statusReady = true,
      expansionCounts = {}, clickHandler, stubHandler = null, flush = false,
      emptyHtml = "", eager = false,
    } = opts || {};
    const list = Array.isArray(entries) ? entries : [];
    const tiles = list.map((entry) => {
      if (entry.stub) {
        const s = entry.stub;
        return window.renderGamePolaroid(
          { id: null, name: s.name, thumbnail_url: s.thumbnail_url || null, year_published: s.year_published || null },
          {
            variant: "rail",
            showStatus: false,
            meta: entry.meta != null ? entry.meta : "On BoardGameGeek",
            reason: entry.reason || "",
            eager,
            clickHandler: stubHandler ? stubHandler(s) : "",
            interactive: !!stubHandler,
          },
        );
      }
      const game = entry.game;
      const expCount = game.bgg_id && expansionCounts ? (expansionCounts[game.bgg_id] || 0) : 0;
      return window.renderGamePolaroid(game, {
        variant: "rail",
        collectionStatus: statusMap[game.id] || null,
        pending: !statusReady,
        meta: entry.meta,
        reason: entry.reason || "",
        eager,
        badgeHtml: window.renderExpansionBadge ? window.renderExpansionBadge(expCount) : "",
        clickHandler: clickHandler ? clickHandler(game) : "",
      });
    }).join("");
    const body = tiles
      ? `<div class="feed-rail__scroll">${tiles}</div>`
      : (emptyHtml || "");
    return `
      <section class="feed-rail${flush ? " feed-rail--flush" : ""}">
        <header class="feed-rail__header">
          <h3><i data-icon="${escapeAttr(icon || "dices")}" class="w-4 h-4"></i> ${escapeHtml(title || "")}</h3>
        </header>
        ${subtitle ? `<p class="feed-rail__sub">${escapeHtml(subtitle)}</p>` : ""}
        ${body}
      </section>
    `;
  }

  window.renderGameRail = renderGameRail;
})();
