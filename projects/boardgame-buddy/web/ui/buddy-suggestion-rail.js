// ui/buddy-suggestion-rail.js — the canonical buddy-suggestion tile, and the
// "Buddies you may know" rail built out of it.
//
// One tile, rendered identically wherever a suggested person appears. Three
// surfaces use it today:
//   • the Feed, as a `suggested_buddies` card the backend interleaves into
//     the page (rail, Add button)
//   • the Buddies screen, as a standalone section between the Buddies and
//     Played-with lists, fed by GET /buddies/suggested (rail, Add button)
//   • the onboarding "Add buddies" step, as a wrapping grid of tiles the user
//     ticks before sending one batch of requests
//     (widgets/onboarding-buddies-modal.js, fed by
//      GET /buddies/suggested/onboarding)
//
// Per .claude/rules/ui-object-design.md §2 the surface-specific bits — which
// view owns the Add button, and whether a tile commits on tap or toggles a
// selection — are `opts` fields on ONE tile, not a second copy of the markup.

(function () {
  // Why this person is being suggested, not how much.
  //
  // A Feed/Buddies candidate is here for a shared play or a shared buddy;
  // when it's both, the shared play is the one worth saying — it's also what
  // ranked them (migration 057). Those candidates carry no `source`, so the
  // counts are the whole story.
  //
  // The onboarding list adds a second tier (migration 063) whose candidates
  // are neither: people who are simply active in the app, with both counts at
  // zero. Reading the counts alone would label them "Mutual buddy", which is
  // false, so the backend sends the tier and it wins when present.
  function suggestionReason(s) {
    if (s.source === "active") return "Active recently";
    return (s.play_count || 0) > 0 ? "Played with" : "Mutual buddy";
  }

  /**
   * @typedef {Object} SuggestedBuddy
   * @property {string} user_id
   * @property {string} display_name
   * @property {Object|null} [avatar]
   * @property {number} [mutual_count]
   * @property {number} [play_count]
   * @property {"graph"|"active"|null} [source]
   */

  /**
   * One suggestion tile.
   *
   * @param {SuggestedBuddy} s
   * @param {Object} [opts]
   * @param {"add"|"select"} [opts.mode="add"]
   *   "add"    — a per-tile Add button that sends one request on tap, and the
   *              avatar routes to the person's profile.
   *   "select" — the whole tile is a toggle in a multi-select; nothing is
   *              sent until the host's own confirm button. No profile
   *              navigation: the tile IS the control, so a tap on any part of
   *              it must do the one thing.
   * @param {string} [opts.addHandler]  mode "add": global expression called as
   *   `(userId, buttonEl)`, e.g. "window.feedView._addBuddy".
   * @param {boolean} [opts.selected]   mode "select": current tick state.
   * @returns {string} HTML
   */
  function renderBuddySuggestionTile(s, opts) {
    const o = opts || {};
    const select = o.mode === "select";
    const badge = window.BgbBadge.render({
      avatar: s.avatar,
      displayName: s.display_name,
      size: "md",
      extraClass: "buddy-tile__avatar",
    });
    const name = escapeHtml(s.display_name);
    const reason = suggestionReason(s);

    if (select) {
      // A real <button aria-pressed> rather than a div with a click handler:
      // the tick state has to reach a screen reader, and the tile has to be
      // reachable by keyboard — this grid is the only control on the screen.
      return `
        <button type="button"
                class="buddy-tile buddy-tile--select${o.selected ? " is-selected" : ""}"
                data-user-id="${escapeAttr(s.user_id)}"
                aria-pressed="${o.selected ? "true" : "false"}">
          <span class="buddy-tile__check" aria-hidden="true">
            <i data-icon="check" class="w-3 h-3"></i>
          </span>
          <span class="buddy-tile__avatar-wrap">${badge}</span>
          <span class="buddy-tile__name">${name}</span>
          <span class="buddy-tile__reason">${reason}</span>
        </button>
      `;
    }

    const addHandler = o.addHandler || "window.feedView._addBuddy";
    return `
      <div class="buddy-tile">
        <div class="buddy-tile__avatar-wrap"
             onclick="window.router.go('profile-other',{userId:'${s.user_id}'})">
          ${badge}
        </div>
        <div class="buddy-tile__name">${name}</div>
        <div class="buddy-tile__reason">${reason}</div>
        <button class="btn btn-xs btn-primary mt-1"
                onclick="${addHandler}('${s.user_id}', this)">Add</button>
      </div>
    `;
  }

  /**
   * @param {SuggestedBuddy[]} suggestions
   * @param {{ addHandler: string, flush?: boolean }} opts
   *   addHandler — a global expression called as `(userId, buttonEl)` when
   *     the tile's Add button is tapped, e.g. "window.feedView._addBuddy".
   *   flush — drop the rail's own 1rem gutter, for hosts that already pad
   *     their own content (the Buddies screen's <main> carries px-4).
   * @returns {string} HTML, or "" when there is nothing to suggest.
   */
  function renderSuggestedBuddiesRail(suggestions, opts) {
    const list = suggestions || [];
    if (list.length === 0) return "";
    const flush = opts && opts.flush;
    const tiles = list.map((s) => renderBuddySuggestionTile(s, {
      mode: "add",
      addHandler: (opts && opts.addHandler) || "window.feedView._addBuddy",
    })).join("");
    return `
      <section class="feed-rail${flush ? " feed-rail--flush" : ""}">
        <header class="feed-rail__header">
          <h3><i data-icon="user-plus" class="w-4 h-4"></i> Buddies you may know</h3>
        </header>
        <div class="feed-rail__scroll">${tiles}</div>
      </section>
    `;
  }

  window.renderBuddySuggestionTile = renderBuddySuggestionTile;
  window.renderSuggestedBuddiesRail = renderSuggestedBuddiesRail;
})();
