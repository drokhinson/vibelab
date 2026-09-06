// domain/ghost-claim.js — "Is this you?" ghost account claims.
//
// A ghost player is a name someone else typed into a play they logged. It has
// no id and no account, so every call here is keyed by (owner, display name).
// Buddy.linkGhost() is the owner saying "this nickname is Julia's account";
// this is the other direction — the claimant asking, the owner approving, and
// the approval running that same merge.

(function () {
  // Keys of the suggestions currently awaiting an answer. See
  // GhostClaim.setSuggestions below for why this is a set and not a number.
  const _suggestionKeys = new Set();

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
     * Ask `ownerUserId` to link their ghost `displayName` to an account —
     * this one by default, or a buddy's via opts.
     *
     * Idempotent while one is pending. 400 own roster, 403 can't see the
     * plays, 409 already seated / already linked / declined twice, 410 gone.
     *
     * @param {string} ownerUserId
     * @param {string} displayName
     * @param {{claimantUserId?: string, playId?: string}} [opts]
     *   claimantUserId claims on somebody else's behalf. They must be an
     *   accepted buddy (403 not_buddies) and playId is then REQUIRED (400
     *   play_required) — their notification names that game, and it is the only
     *   thing telling them which of a stranger's plays this is about. 409
     *   target_seated if the merge would seat them twice, target_declined if
     *   they have already said it isn't them.
     */
    static create(ownerUserId, displayName, opts) {
      const o = opts || {};
      return window.api.post("/ghost-claims", {
        owner_user_id: ownerUserId,
        display_name: displayName,
        // Omitted rather than sent as null on the self path, so the request
        // body is byte-identical to what it has always been.
        ...(o.claimantUserId ? { claimant_user_id: o.claimantUserId } : {}),
        ...(o.playId ? { play_id: o.playId } : {}),
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

    /**
     * Call off a pending claim, from either end of it.
     *
     * Distinct from reject() the same way Buddy.cancel() is from
     * Buddy.reject(): same row, opposite party, and no strike against the
     * two-ask limit. Two people may call it: whoever ASKED (a withdrawal — the
     * row is deleted) and whoever it was raised FOR (a "that isn't me" — the
     * row is dismissed, so the same buddy cannot re-raise it, though the person
     * themselves may still claim the ghost later). The server picks which by
     * who is calling, and the message it returns says which happened.
     */
    static cancel(claimId) {
      return window.api.post(`/ghost-claims/${claimId}/cancel`, {});
    }

    /**
     * The blast-radius confirmation, in ONE place because two surfaces accept
     * claims (the Buddies screen and the notifications screen) and two copies
     * of this dialog is exactly the anti-pattern ui-object-design.md §3c names.
     *
     * Accepting has always merged EVERY play the owner logged under that name,
     * not just the one the claim was raised from — `rows_merged` in the toast
     * afterwards was the first time a host learned how big that was. This says
     * it first.
     *
     * @param {any} claim a GhostClaimResponse, or a notification row
     * @returns {Promise<boolean>} false = leave the claim pending, send nothing
     */
    static confirmAccept(claim) {
      const c = claim || {};
      const n = c.play_count != null ? c.play_count : c.group_count;
      // Exactly one play has no hidden blast radius to make explicit, and a
      // confirm on it is a tap tax. An UNKNOWN count is NOT the same as one —
      // a row seeded from the profile bundle carries no count, because that RPC
      // does not join the plays — so it gets the countless phrasing rather than
      // silently skipping the guard.
      if (n === 1) return Promise.resolve(true);
      const ghost = c.ghost_display_name || "that name";
      const who = c.claimant_display_name || c.other_display_name
        || c.subject_display_name || "them";
      // Raw strings, NOT escaped: PolaroidPopup.confirm escapes title and body
      // itself, so pre-escaping here would double-escape a ghost called
      // Bob "the ghost" into visible entities.
      return window.PolaroidPopup.confirm({
        title: n == null
          ? `Link every “${ghost}” play to ${who}?`
          : `Link all ${n} “${ghost}” plays to ${who}?`,
        body: `Every play you logged with a player called “${ghost}” moves to `
            + `their account — not just this one — and starts counting towards `
            + `their stats. You can't undo it here.`,
        confirmLabel: "Link all",
        cancelLabel: "Keep as ghost",
        // Not destructive: this ADDS a link, it does not lose anything, and
        // --rust would make the affordance look dangerous at a glance.
        destructive: false,
      });
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
    // Two writers, in order of freshness: the profile bundle (migration 071's
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

    // ── Actionable suggestion count ─────────────────────────────────────────
    // The FOURTH source on the Profile tab's dot, and the other direction from
    // the count above: these are ghosts on a buddy's roster that look like the
    // viewer, waiting on a "That's me" or a "Not me".
    //
    // A Set of keys rather than a bare integer, because a suggestion can be
    // settled from a screen that never loaded the list — the claim sheet opens
    // off any play's scoreboard, and reaches wider than this list does. A
    // decrement keyed by identity is a no-op for a ghost that was never
    // suggested; a blind `count - 1` would quietly undercount what is really
    // waiting. The set is in memory only: it is rebuilt by the boot warm-up
    // and by every visit to the Buddies screen, and dropped on sign-out.

    /** `${owner_user_id}|${ghost_name_key}` — the key ui/ghost-claim-suggestions.js uses. */
    static suggestionKey(s) {
      return `${s.owner_user_id}|${s.ghost_name_key}`;
    }

    /**
     * Rebuild the set from a fetched list and publish its size.
     *
     * Only rows with no claim of their own count. The RPC deliberately keeps a
     * row whose claim is already pending — so the button doesn't vanish under
     * the finger that just tapped it — and hands it back with
     * claim_status='pending'. That row is settled; badging it would advertise
     * work the user has already done.
     */
    static setSuggestions(list) {
      _suggestionKeys.clear();
      for (const s of Array.isArray(list) ? list : []) {
        if (!s || s.claim_status) continue;
        _suggestionKeys.add(GhostClaim.suggestionKey(s));
      }
      GhostClaim._publishSuggestionCount();
    }

    /** One suggestion acted on — claimed or dismissed. No-op if unknown. */
    static settleSuggestion(key) {
      if (!_suggestionKeys.delete(key)) return;
      GhostClaim._publishSuggestionCount();
    }

    static suggestionCount() { return window.store.get("ghostClaimSuggestionCount") || 0; }

    /** Sign-out. The next account's near-matches are not this one's. */
    static forgetSuggestions() {
      _suggestionKeys.clear();
      // No publish: store.reset() zeroes the slot on the same sign-out, and
      // publishing into a store that is about to be rebuilt is noise.
    }

    static _publishSuggestionCount() {
      window.store.set("ghostClaimSuggestionCount", _suggestionKeys.size);
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
