// @ts-check
// ui/qr-camera.js — the app's only getUserMedia consumer.
//
// Wraps a camera stream plus a decode loop behind start/stop/decodeFile, so the
// sheet that shows a scanner never touches the media API directly. That split
// exists for one reason: a camera track that outlives its UI is a privacy bug
// the user can see (the OS indicator stays lit), and the fix is to have exactly
// one place that owns the track and one idempotent stop() that kills it.
//
// stop() must be called from every path that ends scanning — sheet close,
// switching away from the scan tab, a successful decode, and backgrounding.
// This module registers the two document-level ones (visibilitychange,
// pagehide) itself so a caller cannot forget them.
//
// Decoding is jsQR (ui/qr-decode.js), not the platform BarcodeDetector, which
// iOS Safari does not implement.

(function () {
  // jsQR cost scales with pixel count: measured ~9ms on a 480x360 frame and
  // ~52ms at 1280x960 on a dev machine, so a phone at full sensor resolution
  // would miss frames outright. Downscale, then run well under the frame rate —
  // a QR held up to a camera does not need 60 looks per second.
  const MAX_EDGE = 480;
  const DECODE_HZ = 10;

  /**
   * @typedef {Object} StartOptions
   * @property {HTMLVideoElement} video      Where the preview renders.
   * @property {(text: string) => void} onDecode  Called with the raw decoded
   *   text. The camera is NOT stopped automatically — the caller decides
   *   whether the payload is one it wants and calls stop() when it is.
   * @property {(code: string, err?: any) => void} onError  Called with one of
   *   the codes in ERROR_CODES below.
   */

  /**
   * The failure modes worth telling a user apart. `camera_unavailable` is
   * synthetic: it covers an insecure context, where navigator.mediaDevices is
   * undefined rather than throwing — the branch that fires when the app is
   * opened over http:// on a LAN IP.
   * @type {Record<string, string>}
   */
  const ERROR_CODES = {
    NotAllowedError: "denied",
    PermissionDeniedError: "denied",
    NotFoundError: "no_camera",
    DevicesNotFoundError: "no_camera",
    NotReadableError: "in_use",
    TrackStartError: "in_use",
  };

  class QrCamera {
    constructor() {
      /** @type {MediaStream|null} */ this._stream = null;
      /** @type {HTMLVideoElement|null} */ this._video = null;
      /** @type {number|null} */ this._raf = null;
      /** @type {HTMLCanvasElement|null} */ this._canvas = null;
      this._lastDecode = 0;
      // Backgrounding the app must release the track: on iOS the camera
      // indicator otherwise survives a home-swipe. Guarded on `hidden` because
      // visibilitychange fires in both directions.
      this._onHide = () => {
        if (document.hidden) this.stop();
      };
      this._onPageHide = () => this.stop();
    }

    get isRunning() {
      return this._stream !== null;
    }

    /**
     * Open the camera and start looking for a QR code.
     * @param {StartOptions} opts
     * @returns {Promise<void>}
     */
    async start(opts) {
      this.stop();
      const video = opts.video;
      this._video = video;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        opts.onError("camera_unavailable");
        return;
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // `ideal`, not `exact` — a laptop with only a front camera throws
          // OverconstrainedError on exact and would fail for no good reason.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch (err) {
        if (err && err.name === "OverconstrainedError") {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } catch (err2) {
            opts.onError(ERROR_CODES[err2 && err2.name] || "unknown", err2);
            return;
          }
        } else {
          opts.onError(ERROR_CODES[err && err.name] || "unknown", err);
          return;
        }
      }

      // The caller may have closed the sheet while the permission prompt was
      // up. Nothing is listening any more, so hand the track straight back
      // rather than leaving the indicator lit on a dead surface.
      if (this._video !== video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      this._stream = stream;
      // Set as a property as well as an attribute: iOS has been unreliable
      // about honouring a muted attribute on an element built via innerHTML,
      // and an unmuted stream will not autoplay.
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.srcObject = stream;

      document.addEventListener("visibilitychange", this._onHide);
      window.addEventListener("pagehide", this._onPageHide);

      try {
        await video.play();
      } catch (err) {
        // play() lands outside the original tap because getUserMedia was
        // awaited. iOS normally still allows it for a muted playsinline
        // MediaStream; when it does not, the caller renders a tap-to-start
        // affordance rather than a frozen black rectangle.
        //
        // Release the track before handing back. Nothing is scanning it, the
        // caller is about to repaint the <video> out of the DOM, and a lit
        // camera indicator over a panel that is not looking at anything is the
        // exact failure this module exists to prevent. The caller restarts
        // from scratch inside a real gesture.
        this.stop();
        opts.onError("needs_gesture", err);
        return;
      }

      this._lastDecode = 0;
      this._loop(opts);
    }

    /**
     * @param {StartOptions} opts
     * @returns {void}
     */
    _loop(opts) {
      this._raf = requestAnimationFrame(() => this._loop(opts));
      const video = this._video;
      if (!video || video.readyState < 2) return;

      const now = Date.now();
      if (now - this._lastDecode < 1000 / DECODE_HZ) return;
      this._lastDecode = now;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      const ctx = this._ctx(w, h);
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, w, h);
      let result = null;
      try {
        // dontInvert roughly halves the work, and a QR shown on a screen or
        // printed on paper is always dark-on-light.
        result = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
          inversionAttempts: "dontInvert",
        });
      } catch (_) {
        return;
      }
      if (result && result.data) opts.onDecode(result.data);
    }

    /**
     * Decode a still image the user picked. The escape hatch when the camera is
     * blocked — and on iOS, `accept="image/*"` offers Take Photo, so this is
     * itself a second camera path that survives a denied getUserMedia.
     * @param {File|Blob} file
     * @returns {Promise<string|null>} The decoded text, or null if none found.
     */
    async decodeFile(file) {
      const bitmap = await this._toBitmap(file);
      // Screenshots are larger than camera frames and a QR in one can be small,
      // so allow more detail here than the live loop — there is no frame budget.
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = this._ctx(w, h);
      // Release the bitmap on the failure path too — an ImageBitmap holds
      // decoded pixels until it is closed or collected.
      if (!ctx) {
        if (typeof bitmap.close === "function") bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      if (typeof bitmap.close === "function") bitmap.close();
      // A saved screenshot may be a dark-mode render, so try both polarities.
      const result = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
        inversionAttempts: "attemptBoth",
      });
      return result && result.data ? result.data : null;
    }

    /**
     * @param {File|Blob} file
     * @returns {Promise<HTMLImageElement|ImageBitmap>}
     */
    _toBitmap(file) {
      if (typeof createImageBitmap === "function") return createImageBitmap(file);
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Could not read that image"));
        };
        img.src = url;
      });
    }

    /**
     * One reused offscreen canvas — a new one per frame at 10Hz is pure garbage.
     * @param {number} w
     * @param {number} h
     * @returns {CanvasRenderingContext2D|null}
     */
    _ctx(w, h) {
      if (!this._canvas) this._canvas = document.createElement("canvas");
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
      }
      // willReadFrequently: every frame round-trips through getImageData, which
      // is the pathological case for a GPU-backed canvas.
      return this._canvas.getContext("2d", { willReadFrequently: true });
    }

    /**
     * Release the camera. Idempotent and safe to call when never started —
     * callers are meant to fire it defensively from every exit path.
     * @returns {void}
     */
    stop() {
      if (this._raf !== null) {
        cancelAnimationFrame(this._raf);
        this._raf = null;
      }
      document.removeEventListener("visibilitychange", this._onHide);
      window.removeEventListener("pagehide", this._onPageHide);
      if (this._stream) {
        this._stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch (_) {}
        });
        this._stream = null;
      }
      if (this._video) {
        try {
          this._video.pause();
        } catch (_) {}
        this._video.srcObject = null;
        this._video = null;
      }
    }
  }

  window.BgbQrCamera = new QrCamera();
})();
