// @ts-check
// widgets/ghost-claim-sheet.js — "is this you?", for one ghost on one play.
//
// Opened by tapping a ghost row on the back of a polaroid or in the play-detail
// popup (see ui/player-row-action.js, which decides when the row offers it).
// Until this existed those rows were inert, which meant the one row a person
// most needs to tap — their own name, typed by someone else — did nothing.
//
// Built on ui/bottom-sheet.js rather than as another bespoke modal: overlays.md
// §7 already records four widgets re-implementing that lifecycle by hand.
// widgets/buddy-qr-sheet.js is the closest precedent — a card about ONE person
// with two ways forward — and this borrows its _seq discipline for the same
// reason: the sheet paints a skeleton, awaits a lookup, and must not paint the
// answer over a sheet the user has already closed or re-opened elsewhere.

(function () {
  const escapeHtml = window.escapeHtml;
  const escapeAttr = window.escapeAttr;

  // What the server says is standing in the way, in the user's words. The
  // server sends a code rather than a sentence so the wording lives with the
  // UI — see bgb_ghost_claim_detail's blocked_reason.
  const BLOCKED_COPY = {
    own_roster: "This is one of your own ghost players. You can link it from Buddies.",
    already_seated: "You're already a player on one of these plays, so this ghost is someone else.",
    already_linked: "These plays are already linked to your account.",
    pending: "You've already asked. They'll see it on their Buddies screen.",
    declined_twice: "They've said this isn't you.",
  };

  // The blocked reasons where "not you, but you might know who" is the natural
  // next question. already_seated is the load-bearing one: it means the viewer
  // was AT that table, which makes them the best placed person alive to say who
  // the other name belongs to. own_roster is absent on purpose — the owner's
  // tool is the Buddies Link panel, which needs nobody's approval.
  const PROXY_INVITE = {
    already_seated: "You were at this table — do you know who this is?",
    already_linked: "Was this someone else at the table?",
    pending: "Was this someone else at the table?",
    declined_twice: "Was this someone else at the table?",
  };

  /**
   * @typedef {Object} GhostClaimOpenOpts
   * @property {string} playId
   * @property {string} displayName        the ghost's name, as typed
   * @property {(() => void)} [onClaimed]  fires once, after a successful ask
   * @property {boolean} [selfBlocked]     the caller already knows the viewer
   *   sits on this play, so the ghost cannot be them. A HINT for the opening
   *   title only — the lookup is what actually decides, and it arrives a moment
   *   later. Getting it wrong costs a heading, never an outcome.
   */

  class GhostClaimSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-ghost-claim-sheet",
        className: "ghost-claim-sheet",
        label: "Is this you?",
      });
      // Captured before every await that ends in a paint. Deliberately not
      // reset in _reset(), for the reason buddy-qr-sheet gives: it has to
      // outlive the state it guards.
      this._seq = 0;
      this._reset();
    }

    _reset() {
      /** @type {any} */ this._detail = null;
      /** @type {string|null} */ this._error = null;
      /** @type {boolean} */ this._sending = false;
      /** @type {GhostClaimOpenOpts|null} */ this._opts = null;
    }

    get isOpen() { return this._sheet.isOpen; }

    /**
     * The sheet's heading. A viewer who is already seated on this play cannot
     * be this ghost, so leading them with "Is this you?" asks a question whose
     * answer they can see is no — and buries the one they can actually answer.
     */
    _title() {
      const d = this._detail;
      // Only already_seated, not every blocked reason. Sitting at the table is
      // the one state where the viewer CANNOT be this ghost, so the question
      // genuinely changes. "You've already asked" is still the same question,
      // just already answered — re-titling that one would read as a different
      // sheet arriving after a tap that did nothing.
      const cannotBeMe = d
        ? d.blocked_reason === "already_seated"
        : !!(this._opts && this._opts.selfBlocked);
      return cannotBeMe ? "Who is this?" : "Is this you?";
    }

    /** @param {GhostClaimOpenOpts} opts */
    open(opts) {
      this._reset();
      this._opts = opts || null;
      const seq = ++this._seq;
      this._sheet.open({
        html: this._panel(),
        label: this._title(),
        // Deliberately null, NOT the row that was tapped. playCardFlip
        // .rerenderCard replaces the whole <article> via replaceWith, so on a
        // polaroid back the <li> that opened this sheet is already detached by
        // the time it closes. The shell's isConnected guard makes passing it
        // harmless, but it would still be a lie about where focus should go.
        returnFocus: null,
        onClick: (e) => this._onClick(e),
        onClose: () => this._reset(),
      });
      this._load(seq);
    }

    close() { this._sheet.close(); }

    async _load(seq) {
      if (!this._opts) return;
      try {
        this._detail = await window.GhostClaim.lookup(
          this._opts.playId, this._opts.displayName,
        );
      } catch (e) {
        this._error = (e && e.message) || "Couldn't load that player.";
      }
      // A close or a second open moved the token — this answer is for a sheet
      // that no longer exists.
      if (seq !== this._seq) return;
      this._paint();
    }

    _paint() {
      const root = this._sheet.el;
      if (!root) return;
      const body = root.querySelector("[data-claim-body]");
      if (body) {
        body.innerHTML = this._body();
        if (window.BgbIcons) window.BgbIcons.render(body);
      }
      // The buttons live outside the scroller (see _foot), so they need their
      // own patch — this is what carries "Looking this up…" to the real
      // answer, and the claim button to "Asking…".
      // The heading is chosen from the lookup too, and the first paint happens
      // before it arrives — so it gets patched alongside the body.
      const title = root.querySelector("[data-claim-title]");
      if (title) title.textContent = this._title();
      const foot = root.querySelector("[data-claim-foot]");
      if (foot) {
        foot.innerHTML = this._foot();
        if (window.BgbIcons) window.BgbIcons.render(foot);
      }
    }

    _panel() {
      const name = (this._opts && this._opts.displayName) || "";
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h2 class="bgb-sheet__title" data-claim-title>${escapeHtml(this._title())}</h2>
          <div class="ghost-claim-sheet__head">
            ${window.BgbBadge.render({
              avatar: null,
              displayName: name,
              size: "md",
              isGhost: true,
              extraClass: "ghost-claim-sheet__badge",
            })}
            <div class="ghost-claim-sheet__name">${escapeHtml(name)}</div>
          </div>
          <div class="ghost-claim-sheet__body" data-claim-body>
            ${this._body()}
          </div>
          <div class="ghost-claim-sheet__foot" data-claim-foot>
            ${this._foot()}
          </div>
        </div>`;
    }

    _body() {
      if (this._error) {
        return `<p class="ghost-claim-sheet__note">${escapeHtml(this._error)}</p>`;
      }
      const d = this._detail;
      if (!d) {
        return `<p class="ghost-claim-sheet__note ghost-claim-sheet__note--loading">Looking this up…</p>`;
      }

      const owner = d.owner_display_name || "someone";
      const n = Number(d.play_count) || 0;
      const plays = `${n} ${n === 1 ? "play" : "plays"}`;
      const last = d.last_played_at ? ` · last ${formatDate(d.last_played_at)}` : "";
      const summary = `
        <p class="ghost-claim-sheet__summary">
          <strong>${escapeHtml(owner)}</strong> logged ${escapeHtml(plays)} with this
          name${escapeHtml(last)}.
        </p>`;

      if (!d.can_claim) {
        const why = BLOCKED_COPY[d.blocked_reason]
          || "This can't be linked to your account.";
        return `${summary}<p class="ghost-claim-sheet__note">${escapeHtml(why)}</p>`
             + this._proxyInvite();
      }

      return `
        ${summary}
        <p class="ghost-claim-sheet__note">
          Claiming asks ${escapeHtml(owner)} to link these plays to your account.
          Nothing changes until they say yes.
        </p>`
        + this._proxyInvite();
    }

    /**
     * "Not you? Say who this is."
     *
     * Prose with an inline control rather than a third button in the footer.
     * _foot's comment argues that the sheet asks ONE yes/no question and must
     * offer exactly the two answers to it; a third peer button there made all
     * three look interchangeable, and this is a different question, not a third
     * answer. It is delegated through data-claim-action like the other two, so
     * no free-text name is ever interpolated into an inline handler.
     *
     * It appears on the blocked states too — that is where it earns its keep,
     * since a viewer who is already seated is precisely the one who knows who
     * the other name is.
     */
    _proxyInvite() {
      const d = this._detail;
      if (!d || !d.can_claim_for_buddy) return "";
      const lead = d.can_claim
        ? "Not you?"
        : (PROXY_INVITE[d.blocked_reason] || "Was this someone else at the table?");
      return `
        <p class="ghost-claim-sheet__note ghost-claim-sheet__proxy">
          ${escapeHtml(lead)}
          <button type="button" class="ghost-claim-sheet__link"
                  data-claim-action="proxy" ${this._sending ? "disabled" : ""}>
            Say who this is
          </button>
        </p>`;
    }

    /**
     * The sheet's buttons. ONE set per state, and never a "Not me" next to a
     * "Cancel": the sheet asks a single yes/no question, so it offers exactly
     * the two answers to it. The way out WITHOUT answering is the backdrop,
     * Escape and the grip — a third button competing with "Not me" only made
     * the two look interchangeable, which they are not ("Not me" is a write
     * that suppresses the suggestion for good).
     *
     * Rendered into a flex:none host rather than inside [data-claim-body], per
     * overlays.md §3: the prose is the growable child, and commit buttons must
     * not be able to scroll out from under the thumb.
     */
    _foot() {
      const d = this._detail;
      // Still looking it up, an error, or a blocked reason — there is no
      // question on screen to answer, so the only control is the way out.
      if (!d || !d.can_claim) {
        return `<button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>`;
      }
      // The primary action names the person who has to answer it, because that
      // is the part a user needs to weigh before tapping: this is not a
      // setting, it is a message to a friend.
      const owner = d.owner_display_name || "someone";
      return `
        <div class="ghost-claim-sheet__actions">
          <button class="btn btn-primary bgb-sheet__confirm" type="button"
                  data-claim-action="claim" ${this._sending ? "disabled" : ""}>
            ${this._sending ? "Asking…" : `That's me — ask ${escapeHtml(owner)}`}
          </button>
          <button class="btn btn-ghost ghost-claim-sheet__dismiss" type="button"
                  data-claim-action="dismiss" ${this._sending ? "disabled" : ""}>
            Not me
          </button>
        </div>`;
    }

    _onClick(e) {
      const btn = e.target && e.target.closest
        ? e.target.closest("[data-claim-action]")
        : null;
      if (!btn) return;
      const action = btn.getAttribute("data-claim-action");
      if (action === "claim") this._claim();
      else if (action === "dismiss") this._dismiss();
      else if (action === "proxy") this._proxy();
    }

    /**
     * Hand off to the buddy picker.
     *
     * Closes first rather than stacking a sheet on a sheet. Stacking would
     * work — BgbBackGuard keeps a layer stack, and the shell's scroll lock is
     * LIFO-safe — but this sheet has nothing left to say once the picker is up,
     * and closing means the picker cannot be repainted over by a _load() that
     * is still in flight behind it. `_detail` goes by value for the same
     * reason: the picker outlives the sheet's `_seq`.
     */
    _proxy() {
      const d = this._detail;
      if (!d || this._sending) return;
      const playId = (this._opts && this._opts.playId) || null;
      const onClaimed = (this._opts && this._opts.onClaimed) || null;
      this.close();
      window.GhostClaimProxy.pick({
        detail: d,
        playId,
        onDone: onClaimed || undefined,
      });
    }

    async _claim() {
      const d = this._detail;
      if (!d || this._sending) return;
      this._sending = true;
      this._paint();
      const seq = this._seq;
      try {
        await window.GhostClaim.create(d.owner_user_id, d.ghost_display_name);
      } catch (err) {
        if (seq !== this._seq) return;
        this._sending = false;
        this._paint();
        if (typeof showToast === "function") {
          showToast((err && err.message) || "Couldn't send that request", "error");
        }
        return;
      }
      if (seq !== this._seq) return;
      // The REQUEST count only moves for the owner, who is not the person
      // holding this phone. The SUGGESTION count is ours though: if this ghost
      // was one the app was offering on the Buddies screen, it is settled now
      // and must come off the Profile tab's dot without waiting for a visit
      // there. A ghost that was never suggested — this sheet opens off any
      // play's scoreboard and reaches wider than that list — is not in the key
      // set, and settleSuggestion no-ops on it rather than undercounting.
      window.GhostClaim.settleSuggestion(window.GhostClaim.suggestionKey(d));
      this.close();
      if (typeof showToast === "function") {
        showToast(`Asked ${d.owner_display_name} to link these plays`, "success");
      }
      if (this._opts && this._opts.onClaimed) this._opts.onClaimed();
    }

    async _dismiss() {
      const d = this._detail;
      if (!d || this._sending) return;
      this._sending = true;
      const seq = this._seq;
      try {
        await window.GhostClaim.dismiss(d.owner_user_id, d.ghost_display_name);
      } catch (err) {
        if (seq !== this._seq) return;
        this._sending = false;
        this._paint();
        if (typeof showToast === "function") {
          showToast((err && err.message) || "Couldn't dismiss that", "error");
        }
        return;
      }
      if (seq !== this._seq) return;
      // Same as _claim above: "Not me" settles the suggestion for this device.
      window.GhostClaim.settleSuggestion(window.GhostClaim.suggestionKey(d));
      this.close();
    }
  }

  window.GhostClaimSheet = new GhostClaimSheet();
})();
