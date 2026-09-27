// widgets/play-step-pager.js — the Play step's three pages on a phone or tablet.
//
// Players, scores and the reference guide sit side by side, one page wide
// each, and a sideways drag turns between them with the same slide as the
// play-detail card (widgets/play-detail-pager.js, whose MOTION constants this
// reads): the neighbour rides in beside the page at 0.85 scale and 0.65
// opacity, a 72px drag or a flick commits, and either end rubber-bands. The
// dots under the pages are the same turn for a tap, and ←/→ for a keyboard.
//
// Phone and tablet tiers. On the rail tiers (wide, land) the host view lays the
// three blocks out side by side (styles.css, "Play step pages") and every page
// rule is scoped to the phone and tablet tiers, so the custom properties this
// writes are inert there — `active()` is what stops the gesture listening.
//
// THE STATE LIVES ON THE VIEW'S CONTAINER, NOT ON THE PAGES. The host
// repaints by replacing its container's innerHTML (play-flow-view#render), so
// every page element is a new node after a repaint. The offset, scale and
// opacity of each page are custom properties on the container, which is never
// replaced, and CSS reads them — so a repaint mid-turn or mid-drag keeps the
// pages exactly where they were (.claude/rules/card-gestures.md §3).
//
// API:
//   BgbPlayStepPager.attach(root, { count, start, active, onTurn })
//     → { turnTo(i, { animate }), reset(i), sync(), get index }
//     root    — the view's container (persists across repaints)
//     active  — () => boolean: phone tier, Play phase, pager on screen
//     onTurn  — (index) => void, after a turn lands

// @ts-check

(function () {
  const PAGER_SEL = ".play-pager";
  const PAGE_SEL = "[data-pp-page]";
  const DOT_SEL = "[data-pp-dot]";

  const FALLBACK = {
    SLOP_PX: 8, COMMIT_PX: 72, FLICK_V: 0.5, FLICK_MIN_PX: 28,
    TURN_MS: 220, GAP_PX: 16, PEEK_SCALE: 0.85, PEEK_OPACITY: 0.65,
  };
  const motion = () => (window.PlayDetailPager && window.PlayDetailPager.MOTION) || FALLBACK;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /**
   * The sideways scroller between the touch and its page, if any — a grid
   * wider than the phone, which at 390px is already true of four players.
   * @param {Element} t
   * @returns {HTMLElement|null}
   */
  function sideScrollerOf(t) {
    for (let el = /** @type {Element|null} */ (t); el && !el.matches(PAGE_SEL); el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

  /**
   * Can `el` still scroll the way a finger moving `dx` would take it? Only
   * then is the drag the grid's. At its edge the same drag turns the page —
   * standing down over the whole scroller instead is what left a four-player
   * grid unable to swipe off one side at all.
   * @param {HTMLElement} el @param {number} dx
   */
  function canScrollToward(el, dx) {
    if (dx < 0) return el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    return el.scrollLeft > 1;
  }

  /**
   * @param {HTMLElement} root
   * @param {{ count: number, start: number, active: () => boolean, onTurn?: (i: number) => void }} opts
   */
  function attach(root, opts) {
    let index = opts.start;
    let busy = false;      // a turn or a spring-back is animating
    let drawing = false;   // a finger owns the drag
    let timer = /** @type {any} */ (0);
    let offsetPx = 0;

    const pager = () => /** @type {HTMLElement|null} */ (root.querySelector(PAGER_SEL));
    const clamp = (i) => Math.max(0, Math.min(opts.count - 1, i));

    /** Page width plus a gap and a peek-scaled half page: clear of the screen. */
    function measure() {
      const p = pager();
      const w = p ? p.clientWidth : 0;
      if (w > 0) {
        const M = motion();
        offsetPx = Math.max(w / 2 + (M.PEEK_SCALE * w) / 2 + M.GAP_PX, w / 2);
      }
      return offsetPx;
    }

    /** @param {number} dx */
    function paint(dx) {
      const off = offsetPx || measure();
      if (!off) return;   // not laid out (another phase) — keep what is there
      const M = motion();
      for (let i = 0; i < opts.count; i++) {
        const x = dx + (i - index) * off;
        const t = Math.min(1, Math.abs(x) / off);
        root.style.setProperty(`--pp-x${i}`, x.toFixed(1) + "px");
        root.style.setProperty(`--pp-s${i}`, (1 - (1 - M.PEEK_SCALE) * t).toFixed(4));
        root.style.setProperty(`--pp-o${i}`, (1 - (1 - M.PEEK_OPACITY) * t).toFixed(3));
      }
    }

    /** Off-screen pages take no focus and say nothing; the dots follow. */
    function settle() {
      const on = opts.active();
      root.querySelectorAll(PAGE_SEL).forEach((el) => {
        const hide = on && Number(/** @type {HTMLElement} */ (el).dataset.ppPage) !== index;
        /** @type {HTMLElement} */ (el).inert = hide;
        if (hide) el.setAttribute("aria-hidden", "true");
        else el.removeAttribute("aria-hidden");
      });
      root.querySelectorAll(DOT_SEL).forEach((d) => {
        d.setAttribute("aria-selected", Number(/** @type {HTMLElement} */ (d).dataset.ppDot) === index ? "true" : "false");
      });
    }

    /**
     * Idempotent: after every repaint, a resize or a rotation. A no-op on the
     * transforms mid-gesture, whose own ending paints the rest state.
     * @param {{ force?: boolean }} [o]
     */
    function sync(o) {
      if (o && o.force) offsetPx = 0;
      if (!busy && !drawing) {
        measure();
        paint(0);
      }
      settle();
    }

    function stopTurn() {
      clearTimeout(timer);
      root.classList.remove("is-pp-turning");
      busy = false;
    }

    /** Set the page without a slide — a phase change lands on scores. */
    function reset(i) {
      stopTurn();
      drawing = false;
      index = clamp(i);
      sync();
    }

    /**
     * Slide to page `i` (or back to the current one, for a spring-back). Ends
     * on a page's own transitionend, with a timer as the backstop for a turn
     * that moves nothing.
     * @param {number} i
     * @param {{ animate?: boolean }} [o]
     */
    function turnTo(i, o) {
      const next = clamp(i);
      const moved = next !== index;
      index = next;
      if (!opts.active() || (o && o.animate === false) || reducedMotion()) {
        stopTurn();
        sync();
        if (moved && opts.onTurn) opts.onTurn(index);
        return;
      }
      busy = true;
      clearTimeout(timer);
      // Commit the start state before asking for the transition, or a turn
      // straight off a repaint jumps instead of sliding.
      void root.offsetWidth;
      root.classList.add("is-pp-turning");
      settle();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        root.removeEventListener("transitionend", onEnd);
        stopTurn();
        if (moved && opts.onTurn) opts.onTurn(index);
      };
      const onEnd = (/** @type {TransitionEvent} */ e) => {
        const t = /** @type {Element} */ (e.target);
        if (e.propertyName === "transform" && t.matches && t.matches(PAGE_SEL)) finish();
      };
      root.addEventListener("transitionend", onEnd);
      paint(0);
      timer = setTimeout(finish, motion().TURN_MS + 120);
    }

    // ←/→ from anywhere on the screen but a field.
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (!opts.active() || busy) return;
      const t = /** @type {Element} */ (e.target);
      if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (clamp(index + dir) === index) return;
      e.preventDefault();
      turnTo(index + dir);
    });

    const onResize = () => {
      if (!root.isConnected) { window.removeEventListener("resize", onResize); return; }
      sync({ force: true });
    };
    window.addEventListener("resize", onResize);

    let tracking = false;
    /** @type {HTMLElement|null} */
    let scroller = null;
    let x0 = 0, y0 = 0, dx = 0, lastX = 0, lastT = 0, vel = 0;

    root.addEventListener("touchstart", (e) => {
      tracking = false;
      if (e.touches.length !== 1 || busy || !opts.active()) return;
      const t = /** @type {Element} */ (e.target);
      if (!t.closest || !t.closest(PAGER_SEL)) return;
      // A field the user is already in owns its touches (caret, selection). An
      // unfocused score cell does not: the drag cancels its click, so it never
      // takes focus, and most of the grid page IS score cells.
      if (t === document.activeElement && t.matches("input, textarea, select")) return;
      if (t.closest("textarea, select, [contenteditable]")) return;
      scroller = sideScrollerOf(t);
      tracking = true;
      drawing = false;
      x0 = lastX = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      lastT = e.timeStamp;
      vel = 0;
      dx = 0;
    }, { passive: true });

    root.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const M = motion();
      const t = e.touches[0];
      if (!drawing) {
        const ddx = t.clientX - x0;
        const ddy = t.clientY - y0;
        if (Math.abs(ddx) < M.SLOP_PX && Math.abs(ddy) < M.SLOP_PX) return;
        // Vertical is the page's own scroll (the grid body, the guide).
        if (Math.abs(ddy) >= Math.abs(ddx)) { tracking = false; return; }
        if (scroller && canScrollToward(scroller, ddx)) { tracking = false; return; }
        drawing = true;
        measure();
        x0 = t.clientX;
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) vel = 0.6 * ((t.clientX - lastX) / dt) + 0.4 * vel;
      lastX = t.clientX;
      lastT = e.timeStamp;
      dx = t.clientX - x0;
      const dir = dx < 0 ? 1 : -1;
      // Past either end the page still moves, reluctantly.
      paint(clamp(index + dir) !== index ? dx : dx * 0.25);
    }, { passive: false });

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!drawing) return;
      drawing = false;
      const M = motion();
      const dir = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) >= M.COMMIT_PX;
      const flick = Math.abs(vel) >= M.FLICK_V && Math.abs(dx) >= M.FLICK_MIN_PX
        && Math.sign(vel) === Math.sign(dx);
      turnTo(far || flick ? index + dir : index);
    };
    root.addEventListener("touchend", end, { passive: true });
    root.addEventListener("touchcancel", end, { passive: true });

    return {
      turnTo,
      reset,
      sync,
      get index() { return index; },
    };
  }

  window.BgbPlayStepPager = { attach };
})();
