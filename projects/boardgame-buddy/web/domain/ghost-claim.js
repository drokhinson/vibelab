// domain/ghost-claim.js — "Is this you?" ghost account claims.
//
// A ghost player is a name someone else typed into a play they logged. It has
// no id and no account, so every call here is keyed by (owner, display name).
// Buddy.linkGhost() is the owner saying "this nickname is Julia's account";
// this is the other direction — the claimant asking, the owner approving, and
// the approval running that same merge.

(function () {
  class GhostClaim {
    // ── Reads ───────────────────────────────────────────────────────────────
    //
    // Both lists are UNCACHED, for the reason Buddy.suggested() is: the server
    // already excludes anything the viewer has acted on, so a stale copy would
    // offer a Claim button for a request that is already sent. They are small,
    // and neither is on the boot path.

    /** Buddies' ghosts whose names look like the viewer's. Often empty. */
    static suggestions() {
      return window.api.get("/ghost-claims/suggestions")
        .then((r) => (r && r.suggestions) || []);
    }

    /** Both sides of the viewer's pending claims: { incoming, outgoing }. */
    static list() { return window.api.get("/ghost-claims"); }

    /**
     * One ghost on one play, for the claim sheet. Keyed by the play because
     * that is what a tapped scoreboard row has — and because the play is what
     * the server's visibility check needs.
     *
     * Resolves the suggestion shape plus can_claim / blocked_reason. Rejects
     * 403 (can't see the play) and 410 (the ghost is gone from it).
     */
    static lookup(playId, displayName) {
      return window.api.get("/ghost-claims/lookup", {
        play_id: playId,
        display_name: displayName,
      });
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    /**
     * Ask `ownerUserId` to link their ghost `displayName` to this account.
     * Idempotent while one is pending. 400 own roster, 403 can't see the
     * plays, 409 already seated / already linked / declined twice, 410 gone.
     */
    static create(ownerUserId, displayName) {
      return window.api.post("/ghost-claims", {
        owner_user_id: ownerUserId,
        display_name: displayName,
      });
    }

    /** Approve a claim on one of MY ghosts. Resolves { claim, rows_merged }. */
    static accept(claimId) {
      return window.api.post(`/ghost-claims/${claimId}/accept`, {});
    }

    /** Decline a claim on one of MY ghosts. They may ask once more. */
    static reject(claimId) {
      return window.api.post(`/ghost-claims/${claimId}/reject`, {});
    }

    // Withdraw a claim WE sent. Distinct from reject() the same way
    // Buddy.cancel() is from Buddy.reject(): same row, opposite party, and a
    // withdrawal costs no strike against the two-ask limit.
    static cancel(claimId) {
      return window.api.post(`/ghost-claims/${claimId}/cancel`, {});
    }

    /** "Not me" — stop suggesting this ghost. The owner is never told. */
    static dismiss(ownerUserId, displayName) {
      return window.api.post("/ghost-claims/dismiss", {
        owner_user_id: ownerUserId,
        display_name: displayName,
      });
    }

    // ── Pending incoming count ──────────────────────────────────────────────
    // The third source on the Profile tab's single dot, alongside
    // buddyRequestCount and achievementUnseenCount. Same reasoning as
    // Buddy.setPendingCount: it lives in the store because neither surface
    // that reads it (the nav bar, the hub's Buddies card) is mounted when the
    // other needs the figure.
    //
    // Two writers, in order of freshness: the profile bundle (migration 070's
    // ghost_claims_incoming, refreshed by /bootstrap, the hub, and every
    // tab-focus warmRefresh) and the Buddies screen, whose accept / decline
    // handlers know the new count a round trip before the server does.

    static pendingCount() { return window.store.get("ghostClaimRequestCount") || 0; }

    static setPendingCount(n) {
      window.store.set(
        "ghostClaimRequestCount",
        Math.max(0, Math.floor(Number(n) || 0)),
      );
    }

    /**
     * Publish the count off a bgb_profile_bundle payload. No-ops when the
     * block is absent — the RPC omits it entirely on someone else's profile,
     * and an absent list is "not my business", not "zero waiting".
     */
    static publishPendingFromBundle(bundle) {
      if (!bundle || !Array.isArray(bundle.ghost_claims_incoming)) return;
      GhostClaim.setPendingCount(bundle.ghost_claims_incoming.length);
    }

    /**
     * Nothing of ours is cached, so this exists for what an accepted claim
     * does to OTHER caches: the ghost stops being a ghost, so the roster the
     * Gather picker reads is stale. The plays themselves are Play's business —
     * an accept handler calls Play.invalidateDeps() as well.
     */
    static invalidate() {
      if (window.Buddy && window.Buddy.invalidate) window.Buddy.invalidate();
    }
  }

  window.GhostClaim = GhostClaim;
})();
