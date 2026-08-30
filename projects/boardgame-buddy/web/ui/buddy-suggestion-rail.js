// ui/buddy-suggestion-rail.js — the canonical "Buddies you may know" rail.
//
// One horizontal strip of suggestion tiles, rendered identically wherever it
// appears. Two surfaces use it today: the Feed (as a `suggested_buddies`
// card the backend interleaves into the page) and the Buddies screen (as a
// standalone section between the Buddies and Played-with lists, fed by
// GET /buddies/suggested).
//
// Per .claude/rules/ui-object-design.md §2 the surface-specific bit — which
// view owns the Add button — is an `opts` field, not a second copy of the
// markup.

(function () {
  // Why this person is being suggested, not how much. A candidate is here
  // for a shared play or a shared buddy; when it's both, the shared play is
  // the one worth saying — it's also what ranked them (migration 057).
  function suggestionReason(s) {
    return (s.play_count || 0) > 0 ? "Played with" : "Mutual buddy";
  }

  /**
   * @typedef {Object} SuggestedBuddy
   * @property {string} user_id
   * @property {string} display_name
   * @property {Object|null} [avatar]
   * @property {number} [mutual_count]
   * @property {number} [play_count]
   */

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
    const addHandler = (opts && opts.addHandler) || "window.feedView._addBuddy";
    const flush = opts && opts.flush;
    const tiles = list.map((s) => `
      <div class="buddy-tile">
        <div class="buddy-tile__avatar-wrap"
             onclick="window.router.go('profile-other',{userId:'${s.user_id}'})">
          ${window.BgbBadge.render({ avatar: s.avatar, displayName: s.display_name, size: "md", extraClass: "buddy-tile__avatar" })}
        </div>
        <div class="buddy-tile__name">${escapeHtml(s.display_name)}</div>
        <div class="buddy-tile__reason">${suggestionReason(s)}</div>
        <button class="btn btn-xs btn-primary mt-1"
                onclick="${addHandler}('${s.user_id}', this)">Add</button>
      </div>
    `).join("");
    return `
      <section class="feed-rail${flush ? " feed-rail--flush" : ""}">
        <header class="feed-rail__header">
          <h3><i data-icon="user-plus" class="w-4 h-4"></i> Buddies you may know</h3>
        </header>
        <div class="feed-rail__scroll">${tiles}</div>
      </section>
    `;
  }

  window.renderSuggestedBuddiesRail = renderSuggestedBuddiesRail;
})();
