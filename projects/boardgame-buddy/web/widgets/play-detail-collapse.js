// widgets/play-detail-collapse.js — pull the play-detail popup down to close
// it, and fly its photo back into the polaroid it was opened from (the flight
// itself is widgets/play-detail-flight.js).
//
// The popup is the polaroid card "expanded", so closing it by dragging should
// read as the reverse of that: the card follows the finger down, and on release
// the photo lifts off it (a small snap up and out), then shrinks into the
// matching card in the list underneath while the rest of the popup drops away.
//
// Touch-only, like ui/pull-to-refresh.js and for the same reason: the gesture is
// a phone gesture, and the ×, a tap outside and Escape stay the exits
// everywhere else.
//
// STATE LIVES ON THE BACKDROP, NOT THE CARD. The popup repaints through
// BgbDomPatch.morph, which rewrites the card's own attributes to match fresh
// markup — a revalidation landing mid-drag would wipe an inline transform or a
// class on the card and snap it back to the top. The backdrop is the morph ROOT,
// whose own attributes are never touched, so the drag offset is a custom
// property there and the card reads it from CSS.
//
// API:
//   window.PlayDetailCollapse.attach(root, { canDrag, playId, close })
//     root    — the modal backdrop (BgbModal's el)
//     canDrag — () => boolean; false while editing, saving or covered
//     playId  — () => string|null; the play on screen, to find its card
//     close   — () => void; the popup's dismiss()

// @ts-check

(function () {
  // Below this a move is a tap's jitter or the start of a sideways swipe.
  const SLOP_PX = 8;
  // Pull past this and releasing closes. Long enough that a scroll which
  // happens to start at the top doesn't close the card by accident.
  const COMMIT_PX = 110;
  // A short, fast flick closes too — px per ms, measured over the last move.
  const FLICK_V = 0.55;
  const FLICK_MIN_PX = 36;
  // Must match the .is-settling transition in styles.css.
  const SETTLE_MS = 240;

  const CARD_SEL = ".play-detail-popup__card";
  const SCROLL_SEL = ".play-detail-popup__scroll";

  /**
   * @param {HTMLElement} root
   * @param {{ canDrag: () => boolean, playId: () => (string|null), close: () => void }} opts
   */
  function attach(root, opts) {
    if (!("ontouchstart" in window)) return;
    let tracking = false;
    let drawing = false;
    let fromTopbar = false;
    let y0 = 0, x0 = 0, dy = 0;
    let lastY = 0, lastT = 0, vel = 0;
    let settleTimer = /** @type {any} */ (0);

    /** @returns {HTMLElement|null} */
    const scroller = () => root.querySelector(SCROLL_SEL);
    const atTop = () => { const s = scroller(); return !s || s.scrollTop <= 0; };

    function paint(px) {
      const pull = Math.min(1, px / (COMMIT_PX * 2));
      root.style.setProperty("--pdp-drag", px.toFixed(1) + "px");
      root.style.setProperty("--pdp-scale", (1 - pull * 0.06).toFixed(4));
      root.style.setProperty("--pdp-pull", pull.toFixed(3));
    }

    root.addEventListener("touchstart", (e) => {
      tracking = false;
      if (e.touches.length !== 1 || root.classList.contains("is-collapsing")) return;
      const t = /** @type {Element} */ (e.target);
      // A touch on the dim backdrop is the outside-tap exit, not a drag; and a
      // drag that starts in a field is text selection.
      if (!t.closest || !t.closest(CARD_SEL) || t.closest("input, textarea, select")) return;
      if (!opts.canDrag()) return;
      fromTopbar = !!t.closest(".play-detail-popup__topbar");
      // Mid-scroll, a downward drag is the scroll going back up. Only the top
      // bar pulls whatever the scroll offset — it never scrolls itself.
      if (!fromTopbar && !atTop()) return;
      tracking = true;
      drawing = false;
      y0 = lastY = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      lastT = e.timeStamp;
      vel = 0;
    }, { passive: true });

    // Non-passive: once the pull is ours, every move has to be prevented or the
    // scroller (or iOS's rubber band) takes the gesture back mid-drag.
    root.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const ddy = t.clientY - y0;
      const ddx = t.clientX - x0;
      if (!drawing) {
        if (Math.abs(ddy) < SLOP_PX && Math.abs(ddx) < SLOP_PX) return;
        // Up, sideways (the rounds grid scrolls sideways), or the list moved
        // off its top: not ours, for the rest of this touch.
        if (ddy <= 0 || Math.abs(ddx) > Math.abs(ddy) || (!fromTopbar && !atTop())) {
          tracking = false;
          return;
        }
        drawing = true;
        clearTimeout(settleTimer);
        root.classList.remove("is-settling");
        // Takes the card off its entrance animation for good — an animation's
        // `both` fill outranks the drag transform. Never removed: taking it
        // off again would replay the entrance.
        root.classList.add("is-pulled");
        // Measured from here, so the card doesn't jump by the slop.
        y0 = t.clientY;
      }
      e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) vel = 0.6 * ((t.clientY - lastY) / dt) + 0.4 * vel;
      lastY = t.clientY;
      lastT = e.timeStamp;
      dy = Math.max(0, t.clientY - y0);
      paint(dy);
    }, { passive: false });

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!drawing) return;
      drawing = false;
      if (dy >= COMMIT_PX || (vel >= FLICK_V && dy >= FLICK_MIN_PX)) {
        collapse(root, opts.playId(), opts.close);
        return;
      }
      root.classList.add("is-settling");
      paint(0);
      settleTimer = setTimeout(() => root.classList.remove("is-settling"), SETTLE_MS);
    };
    root.addEventListener("touchend", end, { passive: true });
    root.addEventListener("touchcancel", end, { passive: true });
  }

  /**
   * Close the popup with the photo flying back into its polaroid
   * (widgets/play-detail-flight.js). Measured before close() runs — the
   * popup's reset clears state the markup reads.
   * @param {HTMLElement} root
   * @param {string|null} playId
   * @param {() => void} close
   */
  function collapse(root, playId, close) {
    const F = window.PlayDetailFlight;
    const card = root.querySelector(CARD_SEL);
    // The play's own photo, else the game art in the header — which is what the
    // polaroid shows in its photo slot when nobody uploaded one.
    const photo = /** @type {HTMLImageElement|null} */ (card && (
      card.querySelector(".play-detail-popup__photo") ||
      card.querySelector(".play-detail__game-thumb")));
    const frame = F.findLanding(playId);
    if (frame && !F.reducedMotion()) F.reveal(frame);

    root.classList.add("is-pulled", "is-collapsing");
    root.style.setProperty("--pdp-drag", Math.round(window.innerHeight * 0.6) + "px");

    if (photo && frame && photo.complete && photo.naturalWidth && !F.reducedMotion()) {
      F.flyBack(photo, frame);
    }
    close();
  }

  window.PlayDetailCollapse = { attach };
})();
