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
   * @property {(userId: string) => void} onGoToProfile  Close the sheet and
   *   route to that person. The scan half never touches the sheet's lifecycle
   *   itself, so leaving is the sheet's call to make.
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
   * @param {"read"|"add"} [phase]  Which half failed. The token is verified
   *   twice now — once to show who the code belongs to, once to act on it — and
   *   the same status means different things either side of the user's tap.
   * @returns {string}
   */
  function errorCopy(err, phase) {
    const adding = phase !== "read";
    if (err && (err.offline || err.status === 0)) {
      return "You're offline — reconnect and scan again.";
    }
    switch (err && err.status) {
      // 410 is the expired-or-forged branch, and it is genuinely common: a new
      // user who followed the QR with their phone camera can easily spend
      // longer than the token's life signing in before they land here. It is
      // now also reachable AFTER the code resolved — the token can die while
      // the user is deciding — which is a different sentence.
      case 410:
        return adding
          ? "That code expired while you were deciding. Ask them to show it again."
          : "That code has expired. Ask them to show it again.";
      case 400:
        return "That's your own code.";
      case 403:
        return "You can't add this person.";
      case 404:
        return "That account no longer exists.";
      default:
        return adding ? "Couldn't add them just now." : "Couldn't read that code just now.";
    }
  }

  /**
   * The panel's one button shape. `--go` is the filled variant.
   * @param {string} label
   * @param {string} attrs  Interpolated RAW into the markup — every call site
   *   must pass a string literal. Never route user or server data through it.
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
    // The decoder is loaded on demand (ui/lazy-script.js), so a dead connection
    // can leave the camera perfectly available and the scanner still unusable.
    // Say that, rather than blaming the camera.
    decoder_unavailable: "Couldn't load the scanner. Check your connection and try again.",
  };

  class BuddyQrScan {
    constructor() {
      // Deliberately NOT reset in _reset(): this counter is what lets a
      // response that arrives after a tab switch be dropped, so it has to
      // outlive the state it guards. Zeroing it on every leave() would let an
      // in-flight request from a previous visit match the new visit's token
      // and paint over it.
      this._seq = 0;
      this._reset();
    }

    _reset() {
      /** @type {ScanCtx|null} */ this._ctx = null;
      /** @type {any} */ this._state = null;   // {kind, message}
      /** @type {any} */ this._result = null;  // {edge, created}
      // The resolved code, held between the scan and the user's decision. The
      // token rides along because "Buddy up" redeems the SAME one — re-reading
      // it from the camera would mean scanning twice.
      /** @type {any} */ this._peek = null;    // {token, person}
    }

    /** True when there is something on screen the first Escape should clear. */
    get hasMessage() {
      return !!(this._state || this._result || this._peek);
    }

    clearMessage() {
      this._state = null;
      this._result = null;
      this._peek = null;
    }

    /**
     * Take over the sheet body. `token` short-circuits the camera entirely —
     * that is the /b/<token> deep-link path, where there is nothing to scan.
     * @param {ScanCtx} ctx
     * @param {string} [token]
     * @returns {void}
     */
    enter(ctx, token) {
      // No "restore the previous message" branch: the sheet always calls
      // leave() immediately before enter(), so state is null by construction.
      this._ctx = ctx;
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
      if (kind === "buddy-up") { this._buddyUp(); return true; }
      if (kind === "go-profile") { this._goToProfile(); return true; }
      if (kind === "start-camera") {
        // Must go through _renderScanner, not _startCamera: the gesture panel
        // replaced the <video> with its own markup, so starting the camera
        // against a host that no longer has one would silently do nothing.
        this.clearMessage();
        this._renderScanner();
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
      this._resolve(token);
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
      this._resolve(token);
    }

    // ── resolve, then act ────────────────────────────────────────────────────

    /**
     * Turn a scanned token into a person, and stop there.
     *
     * This used to be _redeem(): resolving a code WAS the add, so both accounts
     * became buddies before the scanner had seen a name. A camera pointed at a
     * code is a clear enough intent to treat as consent, which is what made
     * that safe — but it is not clear enough to treat as a DECISION, because
     * scanning is also how you find out what a code is. So the token now
     * resolves to a name and the user picks what to do with it.
     *
     * @param {string} token
     * @returns {Promise<void>}
     */
    async _resolve(token) {
      const seq = ++this._seq;
      this._state = { kind: "pending", message: "Reading that code…" };
      this._result = null;
      this._peek = null;
      this._render();
      try {
        const person = await window.Buddy.peekQr(token);
        if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;
        this._state = null;
        this._peek = { token: token, person: person };
        this._render();
      } catch (err) {
        if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;
        this._peek = null;
        this._state = { kind: "error", message: errorCopy(err, "read") };
        this._render();
      }
    }

    /**
     * Redeem the token the user just looked at. Unchanged from what a scan used
     * to do on its own — one call, both accounts buddies, no pending request.
     * @returns {Promise<void>}
     */
    async _buddyUp() {
      const peek = this._peek;
      // aria-disabled rather than the disabled attribute keeps the button
      // focusable mid-write (a disabled button drops a keyboard user onto
      // <body>), so the re-entrancy guard has to live here.
      if (!peek || (this._state && this._state.kind === "pending")) return;
      // The button stays enabled so it can absorb a tap (see _render), so the
      // "there is nothing to add" case is refused here rather than by the DOM.
      if (!this._relationCopy(peek.person.relation).can) return;
      const seq = ++this._seq;
      this._state = { kind: "pending", message: "Adding…" };
      this._render();
      try {
        const res = await window.Buddy.addByQr(peek.token);
        if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;
        this._state = null;
        this._peek = null;
        this._result = res;
        // The play-partners bundle carries buddy membership, so a stale copy
        // would serve the Gather picker a roster without the new buddy in it.
        window.Buddy.invalidate();
        this._render();
        this._ctx.onAdded(res.edge);
      } catch (err) {
        if (seq !== this._seq || !this._ctx || !this._ctx.isActive()) return;
        // Keep the choice card up rather than dropping back to the camera: the
        // person is still on screen, and an expired token is one "Scan again"
        // away without losing who they were.
        this._state = { kind: "error", message: errorCopy(err, "add") };
        this._render();
      }
    }

    /** Leave for their profile. The sheet owns closing itself. */
    _goToProfile() {
      const peek = this._peek;
      if (!peek || !this._ctx) return;
      this._ctx.onGoToProfile(peek.person.user_id);
    }

    // ── render ───────────────────────────────────────────────────────────────

    // What the viewer already is to this person, and therefore whether "Buddy
    // up" has anything left to do. Every branch still SHOWS them — a scan that
    // resolved to a real account and then said nothing would read as a failure.
    _relationCopy(relation) {
      switch (relation) {
        case "buddies":
          return { line: "You're already buddies — nothing to add.", cta: "Already buddies", can: false };
        case "outgoing":
          // The scan would promote it, but the button has to say what it does.
          return { line: "You've already asked. Adding here accepts it for both of you.", cta: "Buddy up", can: true };
        case "incoming":
          return { line: "They asked to be buddies. Adding here accepts it.", cta: "Accept", can: true };
        case "blocked":
          return { line: "You can't add this person.", cta: "Buddy up", can: false };
        default:
          return { line: "Nothing has been sent yet.", cta: "Buddy up", can: true };
      }
    }

    _render() {
      if (!this._ctx) return;

      // The choice card. A pending message rides ALONGSIDE it rather than
      // replacing it — "Adding…" and a failed add both belong under the face
      // they are about, and dropping back to a bare camera would lose who the
      // user had just resolved.
      if (this._peek) {
        const p = this._peek.person;
        const rel = this._relationCopy(p.relation);
        const msg = this._state || {};
        const busy = msg.kind === "pending";
        this._ctx.paint(`
          <div class="buddy-qr-sheet__result">
            ${window.BgbBadge.render({
              avatar: p.avatar,
              displayName: p.display_name,
              size: "md",
            })}
            <p class="buddy-qr-sheet__name">${escapeHtml(p.display_name)}</p>
            ${p.username
              ? `<p class="buddy-qr-sheet__handle">@${escapeHtml(p.username)}</p>`
              : ""}
            <p class="buddy-qr-sheet__line${msg.kind === "error" ? " buddy-qr-sheet__line--error" : ""}">
              ${escapeHtml(msg.kind === "error" ? msg.message : rel.line)}
            </p>
            <div class="buddy-qr-sheet__choice">
              ${btn("Go to profile", 'data-qr-action="go-profile"')}
              ${btn(busy ? "Adding…" : rel.cta,
                    // aria-disabled, never the disabled attribute. Two reasons,
                    // and the second one is a phone bug rather than a nicety:
                    //   * a disabled button cannot hold focus, so it drops a
                    //     keyboard user onto <body> the moment it paints;
                    //   * Chrome's touch adjustment snaps a tap that lands on a
                    //     non-interactive control to the nearest interactive
                    //     one — so tapping a truly-disabled "Already buddies"
                    //     fired "Scan a different code" below it and threw away
                    //     the person who had just been scanned. Measured with a
                    //     real touch tap; a mouse click does not do this, which
                    //     is exactly how it would have shipped.
                    // Staying enabled means this button absorbs its own taps.
                    (busy || !rel.can)
                      ? 'data-qr-action="buddy-up" aria-disabled="true"'
                      : 'data-qr-action="buddy-up"',
                    true)}
            </div>
            ${btn("Scan a different code", 'data-qr-action="rescan"')}
          </div>`);
        return;
      }

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
