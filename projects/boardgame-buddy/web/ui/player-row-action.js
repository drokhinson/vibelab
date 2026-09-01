// ui/player-row-action.js — what a scoreboard row does when you tap it.
//
// Two surfaces draw the same list of players on a play: the back of a polaroid
// (ui/play-card.js) and the play-detail popup (widgets/play-detail-popup.js).
// They are instance #1 and #2 of the same row and have already diverged —
// different CSS families, different badge sizes, and the popup dismisses itself
// before navigating.
//
// So this extracts the DECISION, not the markup. Per
// .claude/rules/ui-object-design.md §4 an extraction splits along lifecycle vs
// appearance, and the genuinely identical, genuinely drift-prone part here is
// "is this row a profile link, a ghost claim, or inert" — a question that used
// to be answered by two copies of a function that both returned "" for ghosts.
// Each caller keeps its own <li>.
//
// The claim branch is new. It is why the file exists: a ghost row was inert on
// both surfaces, which is exactly the row a person needs to tap to say "that
// one is me".

(function () {
  /**
   * @typedef {Object} PlayerRowAction
   * @property {"profile"|"claim"} kind
   * @property {string} handler   raw JS for an inline handler — the CALLER is
   *   responsible for escapeAttr'ing it into the attribute (it can carry a
   *   display name, which is free text somebody else typed)
   * @property {string} ariaLabel unescaped; the caller escapes it too
   * @property {string} icon      the trailing affordance's icon name
   */

  /**
   * @param {object} pl   a play_players row: {user_id, name, ...}
   * @param {object} play the hydrated PlayResponse the row belongs to
   * @param {object} me   the signed-in user, or null
   * @param {{dismissFirst?: string}} [opts] JS to run before navigating —
   *   the popup passes its own dismiss() so the destination isn't left
   *   behind a backdrop.
   * @returns {PlayerRowAction|null} null when the row is inert.
   */
  function forRow(pl, play, me, opts) {
    if (!pl) return null;
    const before = (opts && opts.dismissFirst) || "";

    // A real account: open their profile. Unchanged behaviour.
    if (pl.user_id) {
      const route = (me && me.id === pl.user_id)
        ? `window.router.go('profile-self')`
        : `window.router.go('profile-other',{userId:'${jsStr(pl.user_id)}'})`;
      return {
        kind: "profile",
        handler: `event.stopPropagation();${before}${route}`,
        ariaLabel: `Open ${pl.name}'s profile`,
        icon: "chevron-right",
      };
    }

    // A ghost. Offer the claim when it could possibly be the viewer.
    if (!me || !me.id) return null;
    if (!play) return null;
    // Their own roster — Buddies has the owner-side Link panel for that, and
    // asking yourself for permission is nonsense.
    if (play.logged_by_id === me.id) return null;
    // They already sit at this table under their own account, so this ghost is
    // somebody else. Merging would put one person in two seats of one game —
    // the server refuses it too (bgb_ghost_summary's `collides`), but there is
    // no reason to offer a button whose only outcome is a 409.
    if ((play.players || []).some((p) => p.user_id === me.id)) return null;

    // NOTE: no name-similarity check, deliberately. The "Is this you?" list on
    // the Buddies screen is a suggestion and stays conservative; this is a
    // deliberate tap on a specific row, and the matcher does not get a veto
    // over it — nicknames are exactly the case it misses. Everything that
    // would actually block the claim (an existing request, a decline, a
    // visibility problem) is resolved authoritatively by the sheet's lookup.
    const args = `{playId:'${jsStr(play.id)}',displayName:'${jsStr(pl.name)}'}`;
    return {
      kind: "claim",
      handler: `event.stopPropagation();${before}window.GhostClaimSheet.open(${args})`,
      ariaLabel: `${pl.name} has no account — is this you?`,
      // NOT chevron-right. Same-affordance-for-same-destination
      // (ui-object-design.md §3b) cuts both ways: this row goes somewhere
      // different from every other row in the list and must not look identical
      // to them.
      icon: "user-plus",
    };
  }

  window.BgbPlayerRowAction = { for: forRow };
})();
