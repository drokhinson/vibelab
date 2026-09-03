// ui/pull-to-refresh.js — drag the top of a list down to refresh it.
//
// The gesture already existed on these screens; it belonged to the browser and
// it reloaded the whole app. On a PWA that is the worst possible response to
// "show me what's new": a full restart, a splash, a re-boot, and the scroll
// position gone. This takes the gesture over on the two screens that have a
// list worth refreshing and spends it on that list instead.
//
// TAKING IT OVER IS TWO HALVES and both are required. `overscroll-behavior-y:
// contain` (styles.css, under .bgb-ptr-armed) is what stops the browser's own
// refresh from arming; preventDefault() on the first downward touchmove at the
// top is what stops the page rubber-banding while we draw. The class is put on
// <html> by attach() and taken off by detach(), so every screen that has NOT
// opted in keeps the native gesture it has today.
//
// APPENDING, NOT REPLACING. Both callers merge the refreshed first page over
// the first page they are holding and keep the cursor pages below it, so a
// refresh four pages deep does not throw away the three the user scrolled to.
// That merge is the view's job — it knows what its rows are keyed by — so this
// file just runs the callback and animates.
//
// The indicator is ONE element on <body>, not one per list. Only one view is
// mounted at a time, and a per-view element inside the container would be
// destroyed by the next render() — these views rebuild their whole innerHTML on
// every paint, including the one that happens while a refresh is in flight.

(function () {
  // Pull past this and releasing refreshes. Comfortably longer than the slop in
  // a flick, comfortably shorter than a deliberate drag.
  const ARM_PX = 64;
  // The indicator stops travelling here however far the finger goes, so a long
  // drag reads as "yes, already armed" rather than as a stretchy toy.
  const MAX_PX = 104;
  // Finger distance → indicator distance. Under 1 so the pull feels weighted
  // and the arm point sits at roughly 116px of actual movement.
  const RESISTANCE = 0.55;
  // Below this, a touchmove is noise — a tap's own jitter, or the start of a
  // horizontal swipe. Nothing is drawn and nothing is prevented until a move
  // clears it, so taps and sideways scrolls behave exactly as they did.
  const SLOP_PX = 8;
  // How long the indicator stays up after the refresh resolves. Without it a
  // fast response flashes the spinner for one frame, which reads as a glitch
  // rather than as an answer.
  const HOLD_MS = 240;

  let _el = null;      // the shared indicator
  let _disc = null;

  function _ensureEl() {
    if (_el) return _el;
    _el = document.createElement("div");
    _el.className = "bgb-ptr";
    _el.setAttribute("aria-hidden", "true");
    _el.innerHTML = `
      <span class="bgb-ptr__disc">
        <i data-icon="refresh-cw" class="w-4 h-4"></i>
      </span>`;
    document.body.appendChild(_el);
    if (window.BgbIcons) window.BgbIcons.render(_el);
    _disc = _el.querySelector(".bgb-ptr__disc");
    return _el;
  }

  function _scrollTop() {
    // The document is the scroller on every screen this attaches to — see the
    // cascade block in styles.css for why the app deliberately has no inner
    // scroller. pageYOffset rather than scrollingElement.scrollTop because iOS
    // reports a NEGATIVE scrollTop mid-rubber-band and we want that to read as
    // "at the top", which it does.
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  class PullToRefresh {
    /**
     * @param {Object} o
     * @param {HTMLElement} o.host        Element whose touches count — the view's container.
     * @param {() => Promise<any>} o.onRefresh  Runs on release past ARM_PX. Its
     *   rejection is swallowed: a failed refresh leaves the list exactly as it
     *   was, which is the honest outcome and needs no dialog.
     */
    constructor({ host, onRefresh }) {
      this._host = host;
      this._onRefresh = onRefresh;
      this._y0 = 0;
      this._pull = 0;
      this._tracking = false;   // a touch started at the top; not yet drawing
      this._drawing = false;    // past SLOP_PX downward; we own this gesture
      this._busy = false;       // a refresh is in flight
      // Stamped when a refresh starts and bumped by every reset. The refresh
      // chain carries the value it began under and only touches state if that
      // is still current — otherwise it is finishing for a gesture that was
      // already abandoned (the user navigated away mid-pull and came straight
      // back), and clearing `_busy` would stand down the pull they just made.
      this._run_id = 0;
      this._attached = false;
      this._onStart = (e) => this._start(e);
      this._onMove = (e) => this._move(e);
      this._onEnd = () => this._end();
    }

    attach() {
      if (this._attached || !this._host) return;
      this._attached = true;
      _ensureEl();
      // Nothing is prevented in touchstart, so it stays passive. touchmove is
      // the one that has to be able to preventDefault, and a passive listener
      // silently cannot.
      this._host.addEventListener("touchstart", this._onStart, { passive: true });
      this._host.addEventListener("touchmove", this._onMove, { passive: false });
      this._host.addEventListener("touchend", this._onEnd, { passive: true });
      this._host.addEventListener("touchcancel", this._onEnd, { passive: true });
      document.documentElement.classList.add("bgb-ptr-armed");
    }

    detach() {
      if (!this._attached) return;
      this._attached = false;
      this._host.removeEventListener("touchstart", this._onStart);
      this._host.removeEventListener("touchmove", this._onMove);
      this._host.removeEventListener("touchend", this._onEnd);
      this._host.removeEventListener("touchcancel", this._onEnd);
      document.documentElement.classList.remove("bgb-ptr-armed");
      this._reset();
    }

    _start(e) {
      if (this._busy) return;
      // A second finger means a pinch or a two-handed scroll; neither is this.
      if (e.touches.length !== 1) { this._tracking = false; return; }
      if (_scrollTop() > 0) { this._tracking = false; return; }
      this._tracking = true;
      this._drawing = false;
      this._y0 = e.touches[0].clientY;
      this._x0 = e.touches[0].clientX;
    }

    _move(e) {
      if (!this._tracking || this._busy) return;
      const t = e.touches[0];
      const dy = t.clientY - this._y0;
      const dx = t.clientX - this._x0;

      if (!this._drawing) {
        if (Math.abs(dy) < SLOP_PX && Math.abs(dx) < SLOP_PX) return;
        // Upward, sideways, or the list is no longer at the top: not our
        // gesture. Give it up for the rest of this touch rather than
        // re-evaluating on every move — a drag that crosses back over the
        // threshold must not suddenly start hijacking a scroll in progress.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || _scrollTop() > 0) {
          this._tracking = false;
          return;
        }
        this._drawing = true;
      }

      // Held every move, not just the first: iOS keeps firing touchmove during
      // its own rubber-band, and one un-prevented move is enough to hand the
      // gesture back to the browser mid-pull.
      e.preventDefault();
      this._pull = Math.min(MAX_PX, dy * RESISTANCE);
      this._paint();
    }

    _end() {
      // Touching the screen while a refresh is out is not a cancel — the
      // request is still in the air and the indicator is still telling the
      // truth. Resetting here would clear both, and _reset() also bumps the run
      // token, so the refresh would finish into a control that had disowned it.
      if (this._busy) return;
      if (!this._drawing) { this._reset(); return; }
      if (this._pull >= ARM_PX) this._run();
      else this._reset();
    }

    _run() {
      const id = ++this._run_id;
      this._busy = true;
      this._drawing = false;
      this._tracking = false;
      this._pull = ARM_PX;
      this._paint();
      _el.classList.add("is-refreshing");
      return Promise.resolve()
        .then(() => this._onRefresh())
        .catch(() => {})
        .then(() => new Promise((r) => setTimeout(r, HOLD_MS)))
        .then(() => {
          // Not ours any more: detach() (the user navigated away mid-pull) or a
          // later pull has since reset the control. Standing it down here would
          // clear a gesture that is currently in progress, and re-show the
          // indicator over whatever screen they landed on.
          if (id !== this._run_id) return;
          this._busy = false;
          if (this._attached) this._reset();
        });
    }

    _reset() {
      this._run_id++;
      this._tracking = false;
      this._drawing = false;
      this._busy = false;
      this._pull = 0;
      if (!_el) return;
      _el.classList.remove("is-refreshing", "is-armed", "is-pulling");
      _el.style.removeProperty("--ptr-pull");
      _el.style.removeProperty("--ptr-progress");
    }

    _paint() {
      const p = Math.max(0, Math.min(1, this._pull / ARM_PX));
      _el.style.setProperty("--ptr-pull", this._pull.toFixed(1) + "px");
      _el.style.setProperty("--ptr-progress", p.toFixed(3));
      _el.classList.toggle("is-pulling", this._pull > 0);
      _el.classList.toggle("is-armed", this._pull >= ARM_PX);
    }
  }

  // Touch-only, and that is not a gap to fill later. The gesture this replaces
  // is itself touch-only, every screen it attaches to is phone-first, and the
  // pointer equivalent on a desktop — dragging a page that is already at its
  // top — is not a gesture any browser offers. Views keep their own explicit
  // refresh paths (Retry on an error state, a re-mount) for everyone else.
  PullToRefresh.supported = "ontouchstart" in window;

  window.PullToRefresh = PullToRefresh;
})();
