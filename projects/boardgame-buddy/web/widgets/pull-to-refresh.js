// widgets/pull-to-refresh.js — touch pull-to-refresh for a document-scrolled
// view.
//
// Attaches to one view container (the `main[data-view=...]` element). A
// downward drag that STARTS with the document already scrolled to the top
// pulls the container down against a rubber-band resistance; releasing past
// the threshold parks it at a resting offset and runs the caller's
// onRefresh(), then snaps it back as soon as that resolves.
//
// Two implementation notes worth keeping:
//
//   - The offset is a transform on the CONTAINER, not on a wrapper inside it.
//     Views repaint by assigning container.innerHTML, which would blow away
//     any node the widget owned in there; the container element itself
//     survives every render.
//   - The indicator is position:fixed on <body> for the same reason, and
//     because a transformed ancestor would make `fixed` resolve against the
//     container instead of the viewport.
//
// The scroller is always the browser's. Every listener here is passive and
// nothing calls preventDefault: the widget reads the gesture and draws on top
// of it, it never takes it. That is the whole design, and it is what the feed
// in any other app does — you scroll, and if you happen to be at the top and
// keep dragging down, a refresh control appears under your finger.
//
// It is also the fix for how this shipped. The first version claimed the
// gesture (preventDefault on every touchmove) as soon as the finger travelled
// a few px down at the top of the page, and never gave it back when the finger
// turned around. A claimed gesture is one the browser will not scroll with, so
// a flick up that began with the downward roll a thumb makes as it settles
// moved nothing at all — and since the feed opens at the top, that was every
// flick. The only part of the screen that still scrolled was the bottom nav,
// which sits outside the container these listeners are on.
//
// What replaces preventDefault is `overscroll-behavior-y: none` on :root (via
// .bgb-ptr-lock, applied only while a widget is attached). That is what stops
// Chrome Android's own pull-to-refresh from firing on the same drag and stops
// iOS bouncing the document out from under a pull that is already drawing the
// same motion. Removed on detach, so the views that want the native gesture —
// see the cascade note in styles.css — keep it.
//
// Because the page is never blocked, the pull is measured from wherever the
// top was reached rather than from where the finger landed: _touchMove
// re-baselines while the document is still scrolled, so flinging to the top
// and continuing to drag raises the control, exactly as it would natively.

(function () {
  const MAX_PULL = 96;        // hard stop for the drag, in px
  const COMMIT = 8;           // downward travel that turns a touch into a pull
  const THRESHOLD = 64;       // release past this to trigger a refresh
  const RESTING = 52;         // where the container parks while refreshing
  const RESISTANCE = 0.5;     // finger travel → container travel
  const SETTLE_MS = 260;      // return-to-zero animation
  const FLASH_MS = 900;       // how long the result label lingers

  class PullToRefresh {
    /**
     * @param {{container: HTMLElement, onRefresh: () => Promise<string|void>}} opts
     *   onRefresh may resolve to a short label ("2 new plays") that the
     *   indicator flashes before it retracts.
     */
    constructor({ container, onRefresh }) {
      this.container = container;
      this.onRefresh = onRefresh;
      this._startY = 0;         // where the pull is measured from — re-baselined
      this._startX = 0;         //   while the document is still scrolled
      this._dist = 0;
      this._tracking = false;   // a single finger is down and could still pull
      this._busy = false;
      this._dead = false;       // detached — late async work must not repaint
      this._indicator = null;
      this._onStart = (e) => this._touchStart(e);
      this._onMove = (e) => this._touchMove(e);
      this._onEnd = (e) => this._touchEnd(e);
    }

    attach() {
      this._dead = false;       // an instance may be re-attached after detach
      // Every one of these is passive, and passive is load-bearing rather than
      // an optimisation: it is the promise that this widget cannot take a
      // gesture away from the scroller. .bgb-ptr-lock does the job
      // preventDefault used to.
      this.container.addEventListener("touchstart", this._onStart, { passive: true });
      this.container.addEventListener("touchmove", this._onMove, { passive: true });
      this.container.addEventListener("touchend", this._onEnd, { passive: true });
      this.container.addEventListener("touchcancel", this._onEnd, { passive: true });
      document.documentElement.classList.add("bgb-ptr-lock");
      return this;
    }

    detach() {
      // Order matters: a refresh may be in the air, and _reset() declines to
      // strip the container's transform while _busy is set.
      this._dead = true;
      this._busy = false;
      this.container.removeEventListener("touchstart", this._onStart);
      this.container.removeEventListener("touchmove", this._onMove);
      this.container.removeEventListener("touchend", this._onEnd);
      this.container.removeEventListener("touchcancel", this._onEnd);
      document.documentElement.classList.remove("bgb-ptr-lock");
      this._reset(true);
      if (this._indicator) {
        this._indicator.remove();
        this._indicator = null;
      }
    }

    // ── Gesture ─────────────────────────────────────────────────────────────

    _atTop() {
      return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
    }

    _touchStart(e) {
      if (this._busy) return;
      if (!e.touches || e.touches.length !== 1) return;   // pinch → not a pull
      // Deliberately armed wherever the finger lands, not only at the top: the
      // page is free to scroll under it, and _touchMove re-baselines until the
      // top actually arrives. That is what lets one gesture fling to the top
      // and go straight on into a pull.
      this._startY = e.touches[0].clientY;
      this._startX = e.touches[0].clientX;
      this._tracking = true;
      this._dist = 0;
      // The offset has to track the finger frame-for-frame; easing belongs to
      // the release, not the drag.
      this._setTransition(null);
    }

    _touchMove(e) {
      if (!this._tracking || this._busy) return;
      if (!e.touches || e.touches.length !== 1) return this._reset();
      const y = e.touches[0].clientY;
      // Still scrolled: there is no pull to draw, and the browser is busy
      // scrolling. Keep the origin under the finger so the pull starts from 0
      // at the instant the top arrives, mid-gesture or not.
      if (!this._atTop()) {
        this._startY = y;
        this._startX = e.touches[0].clientX;
        if (this._dist !== 0) this._show(0, "idle");
        return;
      }
      const dy = y - this._startY;
      const dx = e.touches[0].clientX - this._startX;
      // A mostly-sideways drag belongs to a horizontal rail
      // (.play-session__scroll and friends) — leave it alone.
      if (Math.abs(dx) > Math.abs(dy)) return this._reset();
      if (dy < COMMIT) {
        // At, above, or barely below where the pull is measured from. Nothing
        // to show — but stay armed rather than resetting, because the finger
        // is still down at the top and may yet turn into a pull. Nothing is
        // being held back from the scroller by staying here.
        if (this._dist !== 0) this._show(0, "idle");
        return;
      }
      const dist = Math.min(MAX_PULL, dy * RESISTANCE);
      this._show(dist, dist >= THRESHOLD ? "ready" : "pull");
    }

    /** Record and paint the pull offset. @param {number} dist px */
    _show(dist, state) {
      this._dist = dist;
      this._paint(dist, state);
    }

    _touchEnd() {
      if (!this._tracking || this._busy) return;
      const shouldRefresh = this._dist >= THRESHOLD;
      this._tracking = false;
      if (!shouldRefresh) return this._reset();
      this._run();
    }

    async _run() {
      this._busy = true;
      this._setTransition(SETTLE_MS);
      this._paintContainer(RESTING);
      this._paintIndicator(RESTING, "busy");
      let label = null;
      try {
        label = await this.onRefresh();
      } catch (_) {
        label = "Couldn't refresh";
      }
      if (this._dead) return;          // view unmounted mid-flight
      // The content goes back where it belongs the moment the data lands —
      // the result label keeps its own place under the header for a beat,
      // since it's fixed to the viewport rather than riding the container.
      this._paintContainer(0);
      if (label) {
        this._paintIndicator(RESTING, "done", label);
        await new Promise((r) => setTimeout(r, FLASH_MS));
        if (this._dead) return;
      }
      this._busy = false;
      this._reset();
    }

    // ── Paint ───────────────────────────────────────────────────────────────

    _setTransition(ms) {
      // Opacity rides along so the indicator fades out on the way back up
      // instead of vanishing. Cleared to "" during a drag — the offset has to
      // track the finger frame-for-frame, with no easing in between.
      const value = ms ? `transform ${ms}ms ease, opacity ${ms}ms ease` : "";
      this.container.style.transition = value;
      if (this._indicator) this._indicator.style.transition = value;
    }

    _reset(immediate = false) {
      this._tracking = false;
      this._dist = 0;
      this._setTransition(immediate ? null : SETTLE_MS);
      this._paint(0, "idle");
      const clear = () => {
        // Only strip the inline styles if nothing started a new pull in the
        // meantime — a transform left on the container would make any
        // position:fixed descendant (modals) resolve against it.
        if (this._tracking || this._busy) return;
        this.container.style.transform = "";
        this.container.style.transition = "";
        if (this._indicator) {
          this._indicator.remove();
          this._indicator = null;
        }
      };
      if (immediate) clear();
      else setTimeout(clear, SETTLE_MS + 20);
    }

    _ensureIndicator() {
      if (this._indicator && this._indicator.isConnected) return this._indicator;
      const el = document.createElement("div");
      el.className = "bgb-ptr";
      el.innerHTML = `
        <span class="bgb-ptr__mark">
          <img src="assets/illustrations/bgb-loading.svg" alt="" />
        </span>
        <span class="bgb-ptr__label"></span>
      `;
      document.body.appendChild(el);
      this._indicator = el;
      return el;
    }

    /** @param {number} dist  container offset in px */
    _paintContainer(dist) {
      if (this._dead) return;
      this.container.style.transform = dist > 0 ? `translateY(${dist}px)` : "";
    }

    /**
     * @param {number} dist    where the indicator sits, in px
     * @param {"idle"|"pull"|"ready"|"busy"|"done"} state
     * @param {string} [label] text for the "done" flash
     */
    _paintIndicator(dist, state, label) {
      if (this._dead) return;
      // Nothing to fade out yet — don't materialize an indicator just to
      // paint it idle (a horizontal swipe resets through here).
      if (dist <= 0 && state === "idle" && !this._indicator) return;
      const el = this._ensureIndicator();
      const progress = Math.min(1, dist / THRESHOLD);
      el.dataset.state = state;
      el.style.transform = `translate(-50%, ${dist}px)`;
      // Fading in with the drag is the pull affordance; once we've committed
      // to a refresh the indicator is a status, so it goes fully opaque —
      // the resting offset sits just under the threshold and would otherwise
      // leave the result label washed out.
      const committed = state === "busy" || state === "done";
      el.style.opacity = committed ? "1" : String(progress);
      // Read by .bgb-ptr__mark's scale() — the mark grows into full size as
      // the drag approaches the threshold, which is the "let go now" cue.
      el.style.setProperty("--ptr-p", String(progress));
      const text = el.querySelector(".bgb-ptr__label");
      if (text) text.textContent = label || "";
      el.classList.toggle("bgb-ptr--labeled", !!label);
    }

    _paint(dist, state, label) {
      this._paintContainer(dist);
      this._paintIndicator(dist, state, label);
    }
  }

  window.BgbPullToRefresh = {
    /**
     * Attach the gesture to a container. Returns the instance; call
     * .detach() from the view's onUnmount.
     */
    attach(opts) {
      return new PullToRefresh(opts).attach();
    },
  };
})();
