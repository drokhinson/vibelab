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

  /**
   * @typedef {Object} GhostClaimOpenOpts
   * @property {string} playId
   * @property {string} displayName        the ghost's name, as typed
   * @property {(() => void)} [onClaimed]  fires once, after a successful ask
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

    /** @param {GhostClaimOpenOpts} opts */
    open(opts) {
      this._reset();
      this._opts = opts || null;
      const seq = ++this._seq;
      this._sheet.open({
        html: this._panel(),
        label: "Is this you?",
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
      const body = root && root.querySelector("[data-claim-body]");
      if (!body) return;
      body.innerHTML = this._body();
      if (window.BgbIcons) window.BgbIcons.render(body);
    }

    _panel() {
      const name = (this._opts && this._opts.displayName) || "";
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h2 class="bgb-sheet__title">Is this you?</h2>
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
          <button class="bgb-sheet__cancel" type="button" data-action="close">Cancel</button>
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
        return `${summary}<p class="ghost-claim-sheet__note">${escapeHtml(why)}</p>`;
      }

      // The primary action names the person who has to answer it, because that
      // is the part a user needs to weigh before tapping: this is not a
      // setting, it is a message to a friend.
      return `
        ${summary}
        <p class="ghost-claim-sheet__note">
          Claiming asks ${escapeHtml(owner)} to link these plays to your account.
          Nothing changes until they say yes.
        </p>
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
      // The count only moves for the OWNER, who is not the person holding this
      // phone — so there is nothing local to publish here, just the sheet to
      // close and the caller to tell.
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
      this.close();
    }
  }

  window.GhostClaimSheet = new GhostClaimSheet();
})();
