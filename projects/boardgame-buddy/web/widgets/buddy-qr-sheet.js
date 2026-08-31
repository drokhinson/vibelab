// @ts-check
// widgets/buddy-qr-sheet.js — add a buddy by QR code.
//
// Two tabs on one sheet: "My code" shows a QR the people around the table scan,
// "Scan" points the camera at theirs. Scanning makes both people buddies
// immediately — no request, no confirmation — which is safe only because the QR
// carries a short-lived signed token rather than a user id. Ids are public
// (every /u/{userId} URL has one), so an id proves nothing; a token exists only
// because its owner had this sheet open seconds ago. See the backend's
// services/buddy_qr_service.py.
//
// Built on ui/bottom-sheet.js rather than as another bespoke modal: overlays.md
// §7 records four widgets already re-implementing that lifecycle by hand, and a
// fifth would be the wrong direction.
//
// This file owns the shell, the tab strip, and the My-code half. The Scan half
// is widgets/buddy-qr-scan.js — it is the part with the camera and the write,
// and splitting there kept both files inside the size ceiling.

(function () {
  // Re-mint 30s inside the server's 180s TTL, so a sheet left face-up on a
  // table never shows a code that has quietly died.
  const REMINT_MS = 150 * 1000;
  // A failed re-mint is not worth interrupting a code that is still good for
  // another 30s — come back sooner instead of painting an error over it.
  const REMINT_RETRY_MS = 15 * 1000;

  const escapeHtml = window.escapeHtml;
  const escapeAttr = window.escapeAttr;

  /**
   * @typedef {Object} BuddyQrOpenOpts
   * @property {'show'|'scan'} [tab]        Which tab to open on. Default 'show'.
   * @property {string} [token]             A token from a /b/<token> deep link.
   *   Present → opens on Scan and redeems it immediately, no camera.
   * @property {Element|null} [returnFocus]
   * @property {(edge: any) => void} [onAdded]  Fires once per successful add.
   */

  class BuddyQrSheet {
    constructor() {
      this._sheet = new window.BgbBottomSheet({
        id: "bgb-buddy-qr-sheet",
        className: "buddy-qr-sheet",
        label: "Add a buddy",
      });
      // Captured before every await that ends in a paint, so a tab switch or a
      // close mid-request cannot repaint over whatever the user moved to.
      // Deliberately NOT reset in _reset(): it has to outlive the state it
      // guards, or a mint still in flight from a previous open would match the
      // next open's token — and the timer it then arms would be unclearable.
      this._seq = 0;
      this._reset();
    }

    _reset() {
      /** @type {'show'|'scan'} */ this._tab = "show";
      /** @type {string|null} */ this._token = null;
      /** @type {any} */ this._remintTimer = null;
      /** @type {BuddyQrOpenOpts} */ this._opts = {};
    }

    get isOpen() {
      return this._sheet.isOpen;
    }

    /** @param {BuddyQrOpenOpts} [opts] */
    open(opts) {
      const o = opts || {};
      this._reset();
      this._opts = o;
      this._tab = o.token || o.tab === "scan" ? "scan" : "show";

      this._sheet.open({
        html: this._renderPanel(),
        label: "Add a buddy",
        returnFocus: o.returnFocus || null,
        onClick: (e) => this._onClick(e),
        onEscape: () => {
          // First Escape backs out of a result or an error, so the user is not
          // dropped off the sheet by the same key that dismissed the message.
          if (window.BuddyQrScan.hasMessage) {
            window.BuddyQrScan.clearMessage();
            this._enterTab(this._tab);
            return true;
          }
          return false;
        },
        onOpen: () => this._enterTab(this._tab),
        onClose: () => {
          window.BuddyQrScan.leave();
          this._clearRemint();
          this._reset();
        },
      });
    }

    close() {
      this._sheet.close();
    }

    // ── shell ────────────────────────────────────────────────────────────────

    _renderPanel() {
      const tab = (key, label, icon) => `
        <button class="bgb-sheet__tab" type="button" role="tab"
                aria-selected="${this._tab === key}" data-qr-tab="${key}">
          <i data-icon="${icon}" class="w-4 h-4"></i> ${escapeHtml(label)}
        </button>`;
      return `
        <div class="bgb-sheet__panel">
          <div class="bgb-sheet__grip" aria-hidden="true"></div>
          <h2 class="bgb-sheet__title">Add a buddy</h2>
          <div class="bgb-sheet__tabs" role="tablist" aria-label="Show or scan a code">
            ${tab("show", "My code", "qr-code")}
            ${tab("scan", "Scan", "camera")}
          </div>
          <div class="buddy-qr-sheet__body" data-qr-body></div>
          <button class="bgb-sheet__cancel" type="button" data-action="close">Done</button>
        </div>`;
    }

    /** The one host that repaints — patching it keeps the tab strip alive. */
    _body() {
      const root = this._sheet.el;
      return root ? root.querySelector("[data-qr-body]") : null;
    }

    /**
     * @param {string} html
     * @returns {void}
     */
    _paint(html) {
      const host = this._body();
      if (!host) return;
      host.innerHTML = html;
      window.BgbIcons.render(host);
    }

    /** The interface widgets/buddy-qr-scan.js drives the body through. */
    _scanCtx() {
      return {
        paint: (html) => this._paint(html),
        body: () => this._body(),
        isActive: () => this._sheet.isOpen && this._tab === "scan",
        onAdded: (edge) => {
          if (this._opts.onAdded) this._opts.onAdded(edge);
        },
      };
    }

    /**
     * @param {any} e
     * @returns {void}
     */
    _onClick(e) {
      const tabBtn = e.target.closest("[data-qr-tab]");
      if (tabBtn) {
        const next = tabBtn.getAttribute("data-qr-tab");
        if (next !== this._tab) {
          window.BuddyQrScan.clearMessage();
          this._enterTab(next);
        }
        return;
      }
      if (this._tab === "scan") window.BuddyQrScan.handleClick(e);
      else if (e.target.closest('[data-qr-action="retry-token"]')) this._enterTab("show");
    }

    /**
     * @param {'show'|'scan'} tab
     * @returns {void}
     */
    _enterTab(tab) {
      this._tab = tab;
      this._syncTabs();
      // Whichever tab we are leaving, its resource stops. The camera in
      // particular must not survive a switch back to My code — a lit indicator
      // over a QR the user is holding up is exactly the wrong signal.
      window.BuddyQrScan.leave();
      this._clearRemint();

      if (tab === "show") {
        this._renderShow();
        return;
      }
      // A deep link arrives with the token already in hand; hand it straight
      // over so the camera never opens for it.
      const token = this._opts.token;
      this._opts.token = undefined;
      window.BuddyQrScan.enter(this._scanCtx(), token);
    }

    _syncTabs() {
      const root = this._sheet.el;
      if (!root) return;
      root.querySelectorAll("[data-qr-tab]").forEach((el) => {
        el.setAttribute("aria-selected", String(el.getAttribute("data-qr-tab") === this._tab));
      });
    }

    // ── my code ──────────────────────────────────────────────────────────────

    _clearRemint() {
      if (this._remintTimer) {
        clearTimeout(this._remintTimer);
        this._remintTimer = null;
      }
    }

    async _renderShow() {
      const seq = ++this._seq;
      this._paint(`<div class="buddy-qr-sheet__state">Making your code…</div>`);
      let res;
      try {
        res = await window.Buddy.qrToken();
      } catch (err) {
        if (seq !== this._seq || !this._showing()) return;
        const offline = err && (err.offline || err.status === 0);
        this._paint(`
          <div class="buddy-qr-sheet__state">
            <p>${escapeHtml(
              offline
                ? "You're offline — a code needs a connection."
                : "Couldn't make a code just now."
            )}</p>
            <button class="bgb-sheet__cancel buddy-qr-sheet__action buddy-qr-sheet__action--go"
                    type="button" data-qr-action="retry-token">Try again</button>
          </div>`);
        return;
      }
      if (seq !== this._seq || !this._showing()) return;

      this._token = res.token;
      this._paintCode();
      this._remintTimer = setTimeout(() => this._remint(), REMINT_MS);
    }

    _showing() {
      return this._sheet.isOpen && this._tab === "show";
    }

    /** Swap the image source in place — a full repaint would flicker. */
    async _remint() {
      const seq = ++this._seq;
      let res;
      try {
        res = await window.Buddy.qrToken();
      } catch (_) {
        if (seq !== this._seq || !this._showing()) return;
        this._remintTimer = setTimeout(() => this._remint(), REMINT_RETRY_MS);
        return;
      }
      if (seq !== this._seq || !this._showing()) return;
      this._token = res.token;
      const host = this._body();
      const img = host && host.querySelector("[data-qr-img]");
      if (img) img.setAttribute("src", this._dataUrl(this._token));
      this._remintTimer = setTimeout(() => this._remint(), REMINT_MS);
    }

    /**
     * @param {string} token
     * @returns {string} A data: GIF, never inline SVG. Setting innerHTML on an
     *   SVG element renders blank in WebKit (mobile-web.md §4); an <img> avoids
     *   the question, and is long-press-saveable on iOS for free.
     */
    _dataUrl(token) {
      const qr = window.qrcode(0, "M");
      qr.addData(window.location.origin + "/b/" + token);
      qr.make();
      return qr.createDataURL(8, 4, "#000000", "#ffffff");
    }

    _paintCode() {
      const me = (window.store && window.store.get("user")) || {};
      const name = me.display_name || "";
      const username = me.username || "";
      this._paint(`
        <div class="buddy-qr-sheet__plate">
          <img class="buddy-qr-sheet__img" data-qr-img alt="Your buddy QR code"
               src="${escapeAttr(this._dataUrl(this._token))}" />
        </div>
        ${name ? `<p class="buddy-qr-sheet__name">${escapeHtml(name)}</p>` : ""}
        ${username ? `<p class="buddy-qr-sheet__hint">@${escapeHtml(username)}</p>` : ""}
        <p class="buddy-qr-sheet__hint">Have them scan this — it adds you both at once.</p>`);
    }
  }

  window.BuddyQrSheet = new BuddyQrSheet();
})();
