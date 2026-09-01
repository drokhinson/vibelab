// domain/buddy-network.js — the second hop, indexed for instant promotion.
//
// GET /buddies/suggested/onboarding ships a `network` array beside its
// suggestions: for each candidate it offers, who that person knows (migration
// 072). This turns that into a lookup the Add-buddies grid can consult
// synchronously, so ticking Priya puts the people Priya knows on screen in the
// same frame — no request, no spinner, nothing to wait for.
//
// Deliberately pure and caller-agnostic. It holds no DOM, no fetch and no
// selection state: it is handed the ids that are ticked and returns the rows
// that ticking them earns. The two surfaces that own a grid — the onboarding
// deck and the Buddies screen's Add card — share it rather than each growing
// their own ranking rules (.claude/rules/ui-object-design.md §2 applied to a
// decision instead of a component).
//
// Promotion is ADDITIVE, and that is a UI decision this module encodes rather
// than one each caller re-makes: `promote()` is asked what is NEW, and a
// caller that stops ticking someone is never told to take anything away.
// Tiles that have already landed stay, because a grid that removes a row on
// untick moves everything below it under the thumb that is still there
// (.claude/rules/overlays.md §6, mobile-web.md §5).

(function () {
  /**
   * @typedef {Object} NetworkGroup
   * @property {string} via_user_id
   * @property {Array<Object>} buddies   SuggestedBuddy rows, in rank order
   */

  class BuddyNetworkIndex {
    /** @param {NetworkGroup[]} groups */
    constructor(groups) {
      // via_user_id -> rows, rank order preserved from the RPC.
      this._byVia = new Map();
      (groups || []).forEach((g) => {
        if (!g || !g.via_user_id || !Array.isArray(g.buddies)) return;
        this._byVia.set(g.via_user_id, g.buddies.filter((b) => b && b.user_id));
      });
      // Everyone this index has already handed out, so a second tick of a
      // second person who knows them does not offer them twice.
      this._issued = new Set();
    }

    /** True when there is nothing to promote from, whatever gets ticked. */
    get isEmpty() { return this._byVia.size === 0; }

    /** Who the index can introduce, for a caller that wants to count first. */
    countFor(viaUserId) {
      const rows = this._byVia.get(viaUserId);
      return rows ? rows.length : 0;
    }

    /**
     * The rows earned by ticking `viaUserId`, minus anyone already on screen
     * and anyone this index has issued before. Records what it returns, so
     * calling it twice for the same person yields nothing the second time.
     *
     * Order is the RPC's: most-connected first inside a seed. Callers append
     * in this order, so the person most worth knowing lands nearest the grid
     * the user is already looking at.
     *
     * @param {string} viaUserId          the ticked person
     * @param {Set<string>|Array<string>} [onScreen]  ids already rendered
     * @returns {Array<Object>} SuggestedBuddy rows, ready to render
     */
    promote(viaUserId, onScreen) {
      const rows = this._byVia.get(viaUserId);
      if (!rows || !rows.length) return [];
      const shown = onScreen instanceof Set
        ? onScreen
        : new Set(onScreen || []);
      const out = [];
      rows.forEach((row) => {
        const id = row.user_id;
        if (!id || id === viaUserId) return;
        if (shown.has(id) || this._issued.has(id)) return;
        this._issued.add(id);
        out.push(row);
      });
      return out;
    }

    /**
     * Un-issue a person, so a later tick can offer them again. Only for a
     * caller that failed to render what promote() handed it — NOT for an
     * untick, which by design takes nothing back.
     */
    release(userId) { this._issued.delete(userId); }
  }

  const BuddyNetwork = {
    /**
     * Build an index from an onboarding-suggestions response. Tolerates the
     * response shape from before migration 072 (no `network` key) and returns
     * an index that simply never promotes anything — first-run must survive a
     * backend that has not caught up.
     *
     * @param {{network?: NetworkGroup[]}|null} response
     * @returns {BuddyNetworkIndex}
     */
    from(response) {
      return new BuddyNetworkIndex((response && response.network) || []);
    },
  };

  window.BuddyNetwork = BuddyNetwork;
  window.BuddyNetworkIndex = BuddyNetworkIndex;
})();
