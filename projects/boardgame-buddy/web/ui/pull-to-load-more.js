// ui/pull-to-load-more.js — drag the end of a list up to load the next page.
//
// The bottom-edge counterpart to ui/pull-to-refresh.js, and deliberately the
// same shape: one shared indicator on <body>, a resisted drag that arms past a
// threshold, and a release that runs the view's callback. Read that file first
// — everything below is the same gesture pointed the other way.
//
// WHY A GESTURE AND NOT THE BUTTON IT REPLACES. Reaching the end of a list is
// already a gesture: the thumb is mid-flick and the next thing it wants is more
// rows. A "Load more" button answers that with a target to find and hit, which
// on a phone means the flick stops, the eye re-acquires, and the thumb travels
// — three steps to continue doing the one thing the user was already doing.
// Carrying the same flick a little further past the end is none of those.
//
// WHAT IS DIFFERENT FROM THE TOP EDGE, and it is one thing: this module does
// NOT contain the page's overscroll. Pull-to-refresh has to, because the
// browser owns the downward drag at the top and would arm its own reload
// underneath ours. Nothing owns the upward drag at the bottom — there is no
// native action there to take over — so the only half needed is
// preventDefault() on the upward move, which stops the rubber-band while we
// draw. Setting `overscroll-behavior-y: contain` here anyway would switch OFF
// the browser's top-of-page reload on a screen that offers no replacement for
// it, which is a thing to lose for nothing.
//
// ONE GESTURE TO REACH THE END, A SECOND TO PULL PAST IT. A touch that starts
// mid-list and scrolls to the bottom does not become a pull, the same way a
// scroll up to the top does not become a refresh: the finger has to come down
// with the list already at its end. That is what makes this an overscroll
// rather than "a fast flick sometimes loads a page".
//
// A SHORT LIST STILL PULLS. When the rows do not fill the screen there is no
// scroll to overscroll, and _atBottom() reads true from the start — so an
// upward drag anywhere in the list arms. That is on purpose: on such a page the
// gesture costs nothing (it would otherwise do nothing at all) and it keeps the
// promise the footer makes, which "pull only when the page is tall enough"
// would quietly break on exactly the lists a search has narrowed.
//
// The indicator is ONE element on <body>, not one per list — same reasoning as
// pull-to-refresh: a per-view element inside the container is destroyed by the
// next render(), including the one that happens while a page is in flight.

(function () {
  // Pull past this and releasing loads. Same numbers as pull-to-refresh: the
  // two gestures are the same gesture and must not feel differently weighted.
  const ARM_PX = 64;
  const MAX_PX = 104;
  const RESISTANCE = 0.55;
  const SLOP_PX = 8;
  const HOLD_MS = 240;
  // How close to the end of the scroll range still counts as "at the end".
  // Sub-pixel layout and browser zoom leave the last fraction of a pixel
  // unreachable, and a document that can never satisfy the test is a gesture
  // that never arms.
  const BOTTOM_SLACK_PX = 4;

  let _el = null;

  function _ensureEl() {
    if (_el) return _el;
    _el = document.createElement("div");
    _el.className = "bgb-ptl";
    _el.setAttribute("aria-hidden", "true");
    // Both glyphs up front, swapped by CSS on .is-loading. The alternative is
    // rewriting innerHTML mid-gesture, which would mean re-hydrating an icon
    // (ui/icons.js replaces the <i>) on the frame the request goes out.
    _el.innerHTML = `
      <span class="bgb-ptl__disc">
        <i data-icon="arrow-down" class="w-4 h-4 bgb-ptl__arrow"></i>
        <i data-icon="loader-2" class="w-4 h-4 bgb-ptl__spin"></i>
      </span>`;
    document.body.appendChild(_el);
    if (window.BgbIcons) window.BgbIcons.render(_el);
    return _el;
  }

  function _atBottom() {
    const doc = document.documentElement;
    // The document is the scroller on every screen this attaches to — see the
    // cascade block in styles.css for why the app deliberately has no inner
    // scroller. iOS reports a scrollTop PAST the maximum mid-rubber-band, which
    // the >= keeps reading as "at the bottom", which it is.
    const y = window.pageYOffset || doc.scrollTop || 0;
    const vh = window.innerHeight || doc.clientHeight || 0;
    return y + vh >= doc.scrollHeight - BOTTOM_SLACK_PX;
  }

  class PullToLoadMore {
    /**
     * @param {Object} o
     * @param {HTMLElement} o.host              Element whose touches count — the view's container.
     * @param {() => Promise<any>} o.onLoadMore Runs on release past ARM_PX. Its
     *   rejection is swallowed: the view owns reporting a failed page, in the
     *   footer strip where the load was asked for.
     * @param {() => boolean} [o.canLoad]       Asked at the start of every touch.
     *   False — nothing left to load, or a page already in flight — and the
     *   touch stays an ordinary scroll. Gating per gesture rather than
     *   attaching and detaching as the list grows means the controller has one
     *   lifetime, the view's, and cannot be torn down mid-run.
     */
    constructor({ host, onLoadMore, canLoad }) {
      this._host = host;
      this._onLoadMore = onLoadMore;
      this._canLoad = canLoad || (() => true);
      this._y0 = 0;
      this._x0 = 0;
      this._pull = 0;
      this._tracking = false;   // a touch started at the end; not yet drawing
      this._drawing = false;    // past SLOP_PX upward; we own this gesture
      this._busy = false;       // a page is in flight
      // Stamped when a load starts and bumped by every reset. The chain
      // carries the value it began under and only touches state if that is
      // still current — otherwise it is finishing for a gesture that was
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
    }

    detach() {
      if (!this._attached) return;
      this._attached = false;
      this._host.removeEventListener("touchstart", this._onStart);
      this._host.removeEventListener("touchmove", this._onMove);
      this._host.removeEventListener("touchend", this._onEnd);
      this._host.removeEventListener("touchcancel", this._onEnd);
      this._reset();
    }

    _start(e) {
      if (this._busy) return;
      // A second finger means a pinch or a two-handed scroll; neither is this.
      if (e.touches.length !== 1) { this._tracking = false; return; }
      if (!this._canLoad() || !_atBottom()) { this._tracking = false; return; }
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
        // Downward, sideways, or the list is no longer at its end: not our
        // gesture. Give it up for the rest of this touch rather than
        // re-evaluating on every move — a drag that crosses back over the
        // threshold must not suddenly start hijacking a scroll in progress.
        if (dy >= 0 || Math.abs(dx) > Math.abs(dy) || !_atBottom()) {
          this._tracking = false;
          return;
        }
        this._drawing = true;
      }

      // Held every move, not just the first: iOS keeps firing touchmove during
      // its own rubber-band, and one un-prevented move is enough to hand the
      // gesture back to the browser mid-pull.
      e.preventDefault();
      this._pull = Math.min(MAX_PX, -dy * RESISTANCE);
      this._paint();
    }

    _end() {
      // Touching the screen while a page is out is not a cancel — the request
      // is still in the air and the indicator is still telling the truth.
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
      _el.classList.add("is-loading");
      return Promise.resolve()
        .then(() => this._onLoadMore())
        .catch(() => {})
        // Without the hold, a page served from cache flashes the spinner for
        // one frame, which reads as a glitch rather than as an answer.
        .then(() => new Promise((r) => setTimeout(r, HOLD_MS)))
        .then(() => {
          // Not ours any more: detach() (the user navigated away mid-pull) or a
          // later pull has since reset the control.
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
      _el.classList.remove("is-loading", "is-armed", "is-pulling");
      _el.style.removeProperty("--ptl-pull");
      _el.style.removeProperty("--ptl-progress");
    }

    _paint() {
      const p = Math.max(0, Math.min(1, this._pull / ARM_PX));
      _el.style.setProperty("--ptl-pull", this._pull.toFixed(1) + "px");
      _el.style.setProperty("--ptl-progress", p.toFixed(3));
      _el.classList.toggle("is-pulling", this._pull > 0);
      _el.classList.toggle("is-armed", this._pull >= ARM_PX);
    }
  }

  // Touch-only, for the same reason pull-to-refresh is: dragging a page that is
  // already at its edge is not a gesture any pointer device offers. The footer
  // strip the views render alongside this is a real button, so a mouse or a
  // keyboard still has the full path to the next page.
  PullToLoadMore.supported = "ontouchstart" in window;

  window.PullToLoadMore = PullToLoadMore;
})();
