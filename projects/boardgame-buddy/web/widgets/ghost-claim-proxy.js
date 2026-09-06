// @ts-check
// widgets/ghost-claim-proxy.js — "that ghost isn't me, but I know who it is".
//
// The other half of widgets/ghost-claim-sheet.js. That sheet asks one person
// one question: is this you? This one is for the answer it could never take —
// no, but it's Dave — which matters because the person best placed to recognise
// a ghost is very often not the ghost. Dave cannot claim a play he isn't in and
// usually cannot even see it; that is what being a ghost on it means.
//
// It owns no chrome of its own. The picker is widgets/player-picker-sheet.js in
// its single-select shape, exactly as views/buddies-view.js#_openLinkSheet uses
// it for the owner-side link — same question ("who is this name?"), same
// machinery, so a second bespoke roster sheet would be instance #2 of something
// that already exists (.claude/rules/ui-object-design.md §4).

(function () {
  // Same cap as the Buddies screen's link sheet. Enough that the obvious answer
  // leads the list, few enough that "closest to Dave" still means something.
  const SUGGEST_MAX = 5;

  /**
   * @typedef {Object} ProxyPickOpts
   * @property {any} detail    the GhostClaimDetail the claim sheet already fetched
   * @property {string} playId the play the request is raised from — REQUIRED by
   *   the server on a proxy claim, because the target's notification names that
   *   game and it is the only thing telling them which play this is about
   * @property {(() => void)} [onDone] fires after a successful ask
   */

  /** @param {ProxyPickOpts} opts */
  async function pick(opts) {
    const d = (opts && opts.detail) || null;
    if (!d || !d.owner_user_id) return;
    const ghost = d.ghost_display_name || "";

    let partners;
    try {
      partners = await window.Buddy.allBuddies();
    } catch (_) {
      if (typeof showToast === "function") {
        showToast("Couldn't load your buddies", "error");
      }
      return;
    }

    const candidates = buddyCandidates(partners);
    if (!candidates.length) {
      // Not an empty picker: a sheet offering nothing reads as broken rather
      // than as "you have nobody to pick yet".
      if (window.PolaroidPopup) {
        window.PolaroidPopup.alert({
          title: "No buddies yet",
          body: `You can only say who “${ghost}” is if they're one of your `
              + `buddies. Add them first, then try again.`,
        });
      }
      return;
    }

    window.PlayerPickerSheet.open({
      candidates,
      // The ghost's own name is the strongest hint available, and the matcher
      // is what turns "Ted" into Tedra Okonjo without a keystroke.
      suggestions: window.BgbNameMatch
        .rank(ghost, candidates, (c) => [c.name, c.username])
        .slice(0, SUGGEST_MAX)
        .map((hit) => hit.row),
      suggestionsLabel: `Closest to “${ghost}”`,
      restLabel: "Your buddies",
      singleSelect: true,
      title: `Who is “${ghost}”?`,
      sub: `${d.owner_display_name || "They"} decides — the request goes to them, `
         + `and to whoever you pick.`,
      // A typed name is not an act here: this is a choice among accounts that
      // already exist, and the server only accepts a real user id. Same
      // reasoning _openLinkSheet gives for its own allowGuest: false.
      allowGuest: false,
      // Deliberately NO searchAll. The target must be an accepted buddy, so
      // reaching past the buddy list would offer people the server answers
      // with a 403 — an affordance whose only outcome is an error.
      returnFocus: document.activeElement,
      onConfirm: (picks) => {
        const p = picks && picks[0];
        if (p && p.user_id) send(d, p, opts);
      },
    });
  }

  /**
   * The viewer's accepted buddies, and only those.
   *
   * Buddy.toPlayerCandidates is the canonical shaping, but it deliberately
   * reaches wider than we may: it also folds in people the viewer has merely
   * shared a table with, and their own ghosts. Both are right for the Gather
   * picker and wrong here — a proxy target must be an account, and an accepted
   * buddy. So the full list is built (which is what carries the "N plays
   * together" hint off `recent`) and then narrowed back to the buddy ids.
   */
  function buddyCandidates(partners) {
    const p = partners || {};
    const accounts = p.accounts || [];
    const buddyIds = new Set(
      accounts.map((b) => (b && (b.other_user_id || b.user_id)) || null)
              .filter(Boolean),
    );
    const me = window.store.get("user");
    const myId = (me && me.id) || null;
    return window.Buddy
      .toPlayerCandidates({ accounts, recent: p.recent || [] })
      .filter((c) => c.user_id && buddyIds.has(c.user_id) && c.user_id !== myId);
  }

  /**
   * Raise the claim.
   *
   * No confirm step: picking a specific person off a named list is already the
   * deliberate second tap, and the self path ("That's me — ask Alice") has none
   * either. The blast-radius confirm belongs to the person who can actually
   * accept, and they get it (GhostClaim.confirmAccept).
   */
  async function send(detail, picked, opts) {
    try {
      await window.GhostClaim.create(
        detail.owner_user_id,
        detail.ghost_display_name,
        { claimantUserId: picked.user_id, playId: opts.playId },
      );
    } catch (err) {
      if (typeof showToast === "function") {
        showToast((err && err.message) || "Couldn't send that request", "error");
      }
      return;
    }
    if (typeof showToast === "function") {
      showToast(
        `Asked ${detail.owner_display_name || "them"} to link these plays to ${picked.name}`,
        "success",
      );
    }
    // Deliberately NOT settleSuggestion: a proxy claim settles nothing about
    // whether this ghost is the VIEWER, which is the only question that list
    // asks. Their own "Is this you?" row, if there is one, is still waiting.
    if (opts && opts.onDone) opts.onDone();
  }

  window.GhostClaimProxy = { pick };
})();
