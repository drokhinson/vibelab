// @ts-check
// widgets/buddy-qr-scan.js — the Scan half of the add-a-buddy sheet.
//
// Split from buddy-qr-sheet.js on the line that matters: this is the half that
// opens the camera and writes to the buddy graph, and it is the half whose
// failure modes need explaining to a user. The sheet owns the tabs and the body
// host; this owns everything that happens once the user is scanning.
//
// The contract with the sheet is the `ScanCtx` below — this module never
// touches the sheet's DOM directly, so the two can't fight over the body host.

(function () {
  const escapeHtml = window.escapeHtml;

  /**
   * @typedef {Object} ScanCtx
   * @property {(html: string) => void} paint  Patch the sheet's body host.
   * @property {() => Element|null} body       The body host, for follow-up wiring.
   * @property {() => boolean} isActive        False once the user has switched
   *   tab or closed the sheet — every await checks this before painting.
   * @property {(edge: any) => void} onAdded
   */

  /**
   * Pull a token out of whatever the scanner read. Accepts the deep-link URL
   * and a bare token, and rejects everything else — pointing the camera at a
   * WiFi QR should say so, not POST a stranger's URL to the buddy endpoint.
   * @param {string} text
   * @returns {string|null}
   */
  function tokenFromScan(text) {
    if (!text) return null;
    const m = String(text)
      .trim()
      .match(/(?:^|\/b\/)([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  }

  /**
   * @param {any} err
   * @returns {string}
   */
  function errorCopy(err) {
    if (err && (err.offline || err.status === 0)) {
      return "You're offline — reconnect and scan again.";
    }
    switch (err && err.status) {
      // 410 is the expired-or-forged branch, and it is genuinely common: a new
      // user who followed the QR with their phone camera can easily spend
      // longer than the token's life signing in before they land here.
      case 410:
        return "That code has expired. Ask them to show it again.";
      case 400:
        return "That's your own code.";
      case 403:
        return "You can't add this person.";
      case 404:
        return "That account no longer exists.";
      default:
        return "Couldn't add them just now.";
    }
  }

  /**
   * The panel's one button shape. `--go` is the filled variant.
   * @param {string} label
   * @param {string} attrs
   * @param {boolean} [go]
   * @returns {string}
   */
  function btn(label, attrs, go) {
    return `<button class="bgb-sheet__cancel buddy-qr-sheet__action${
      go ? " buddy-qr-sheet__action--go" : ""
    }" type="button" ${attrs}>${escapeHtml(label)}</button>`;
  }

  const CAMERA_COPY = {
    denied:
      "Camera access is off. Turn it on in your browser settings and reopen this sheet — or upload a photo of their code instead.",
    no_camera: "This device doesn't have a camera you can scan with.",
    in_use: "Another app is using the camera right now.",
    camera_unavailable: "Scanning needs a secure (https) connection.",
  };

  class BuddyQrScan {
    constructor() {
      this._reset();
    }

    _reset() {
      /** @type {ScanCtx|null} */ this._ctx = null;
      /** @type {any} */ this._state = null;   // {kind, message}
      /** @type {any} */ this._result = null;  // {edge, created}
      this._seq = 0;
    }

    /** True when there is a message or result the first Escape should clear. */
    get hasMessage() {
      return !!(this._state || this._result);
    }

    clearMessage() {
      this._state = null;
      this._result = null;
    }

    /**
     * Take over the sheet body. `token` short-circuits the camera entirely —
     * that is the /b/<token> deep-link path, where there is nothing to scan.
     * @param {ScanCtx} ctx
     * @param {string} [token]
     * @returns {void}
     */
    enter(ctx, token) {
      this._ctx = ctx;
      if (this._state || this._result) {
        this._render();
        return;
      }
      if (token) {
        this._redeem(token);
        return;
      }
      this._renderScanner();
    }

    /** Called on tab switch and sheet close. Must always release the camera. */
    leave() {
      window.BgbQrCamera.stop();
      this._reset();
    }

    /**
     * Click actions this panel owns. Returns true when it handled the event.
     * @param {any} e
     * @returns {boolean}
     */
    handleClick(e) {
      const el = e.target.closest("[data-qr-action]");
      if (!el) return false;
      const kind = el.getAttribute("data-qr-action");
      if (kind === "rescan") {
        this.clearMessage();
        if (this._ctx) this._renderScanner();
        return true;
      }
      if (kind === "start-camera") {
        this._startCamera();
        return true;
      }
      return false;
    }

    // ── camera ───────────────────────────────────────────────────────────────

    _renderScanner() {
      if (!this._ctx) return;
      this._ctx.paint(`
        <div class="buddy-qr-sheet__scan">
          <video class="buddy-qr-sheet__video" playsinline webkit-playsinline muted autoplay></video>
          <div class="buddy-qr-sheet__reticle" aria-hidden="true"></div>
        </div>
        <p class="buddy-qr-sheet__hint" data-qr-hint>Point the camera at their code.</p>
        ${this._fileInput()}`);
      this._wireFile();
      this._startCamera();
    }

    /**
     * Always offered, not only after a failure. On iOS `accept="image/*"`
     * includes Take Photo, so this is a second camera path that still works
     * when getUserMedia has been denied.
     * @returns {string}
     */
    _fileInput() {
      return `
        <input type="file" accept="image/*" id="bgb-qr-file" class="buddy-qr-sheet__file" data-qr-file />
        <label class="buddy-qr-sheet__filebtn" for="bgb-qr-file">
          <i data-icon="image-plus" class="w-4 h-4"></i> Upload a photo instead
        </label>`;
    }

    _wireFile() {
      const host = this._ctx && this._ctx.body();
      const fileEl = host && host.querySelector("[data-qr-file]");
      if (fileEl) fileEl.addEventListener("change", (ev) => this._onFile(ev), { once: true });
    }

    _startCamera() {
      const host = this._ctx && this._ctx.body();
      const video = host && host.querySelector("video");
      if (!video) return;
      window.BgbQrCamera.start({
        video: /** @type {HTMLVideoElement} */ (video),
        onDecode: (text) => this._onDecode(text),
        onError: (code) => this._onCameraError(code),
      });
    }

    /**
     * @param {string} text
     * @returns {void}
     */
    _onDecode(text) {
      const token = tokenFromScan(text);
      if (!token) {
        // Keep scanning — the user has probably just swept past something else
        // on the table — but say why nothing happened.
        const host = this._ctx && this._ctx.body();
        const hint = host && host.querySelector("[data-qr-hint]");
        if (hint) hint.textContent = "That's not a BoardgameBuddy code. Keep looking…";
        return;
      }
      window.BgbQrCamera.stop();
      this._redeem(token);
    }

    /**
     * @param {string} code
     * @returns {void}
     */
    _onCameraError(code) {
      this._state =
        code === "needs_gesture"
          ? { kind: "gesture", message: "" }
          : { kind: "error", message: CAMERA_COPY[code] || "Couldn't start the camera." };
      this._render();
    }

    /**
     * @param {any} ev
     * @returns {Promise<void>}
     */
    async _onFile(ev) {
      const file = ev.target && ev.target.files && ev.target.files[0];
      if (!file) return;
      window.BgbQrCamera.stop();
      const seq = ++this._seq;
      this._state = { kind: "pending", message: "Reading that image…" };
      this._render();

      let text = null;
      try {
        text = await window.BgbQrCamera.decodeFile(file);
      } catch (_) {
        text = null;
      }
      if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;

      const token = text ? tokenFromScan(text) : null;
      if (!token) {
        this._state = {
          kind: "error",
          message: text
            ? "That code isn't a BoardgameBuddy one."
            : "Couldn't find a QR code in that image.",
        };
        this._render();
        return;
      }
      this._redeem(token);
    }

    // ── redeem ───────────────────────────────────────────────────────────────

    /**
     * @param {string} token
     * @returns {Promise<void>}
     */
    async _redeem(token) {
      const seq = ++this._seq;
      this._state = { kind: "pending", message: "Adding…" };
      this._result = null;
      this._render();
      try {
        const res = await window.Buddy.addByQr(token);
        if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;
        this._state = null;
        this._result = res;
        // The play-partners bundle carries buddy membership, so a stale copy
        // would serve the Gather picker a roster without the new buddy in it.
        window.Buddy.invalidate();
        this._render();
        this._ctx.onAdded(res.edge);
      } catch (err) {
        if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;
        this._result = null;
        this._state = { kind: "error", message: errorCopy(err) };
        this._render();
      }
    }

    // ── render ───────────────────────────────────────────────────────────────

    _render() {
      if (!this._ctx) return;

      if (this._result) {
        const edge = this._result.edge;
        const line = this._result.created
          ? `You and ${edge.other_display_name} are now buddies.`
          : `You're already buddies with ${edge.other_display_name}.`;
        this._ctx.paint(`
          <div class="buddy-qr-sheet__result">
            ${window.BgbBadge.render({
              avatar: edge.other_avatar,
              displayName: edge.other_display_name,
              size: "md",
            })}
            <p class="buddy-qr-sheet__name">${escapeHtml(line)}</p>
            <!-- No "Done" here: the panel's own Done is directly below, and
                 two identically-labelled buttons stacked is worse than one. -->
            ${btn("Scan another", 'data-qr-action="rescan"', true)}
          </div>`);
        return;
      }

      const s = this._state || {};
      if (s.kind === "pending") {
        this._ctx.paint(`<div class="buddy-qr-sheet__state">${escapeHtml(s.message)}</div>`);
        return;
      }
      if (s.kind === "gesture") {
        this._ctx.paint(`
          <div class="buddy-qr-sheet__state">
            <p>Ready when you are.</p>
            ${btn("Start camera", 'data-qr-action="start-camera"', true)}
          </div>`);
        return;
      }
      // Error. Scan again re-opens the camera, so an expired code — the common
      // case after a cold deep link — is one tap from a retry, not a dead end.
      this._ctx.paint(`
        <div class="buddy-qr-sheet__state">
          <p>${escapeHtml(s.message || "Something went wrong.")}</p>
          ${btn("Scan again", 'data-qr-action="rescan"', true)}
        </div>
        ${this._fileInput()}`);
      this._wireFile();
    }
  }

  window.BuddyQrScan = new BuddyQrScan();
})();
