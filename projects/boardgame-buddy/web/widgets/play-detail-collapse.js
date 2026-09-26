// widgets/play-detail-collapse.js — pull the play-detail popup down to close
// it, and fly its photo back into the polaroid it was opened from.
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
  const FLIGHT_MS = 480;

  const CARD_SEL = ".play-detail-popup__card";
  const SCROLL_SEL = ".play-detail-popup__scroll";

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

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
   * The polaroid on screen for this play, if any. The router only hides views,
   * so the same play can be mounted in the feed and in a game's reel at once
   * (see rerenderCard in ui/play-card.js) — only a copy that is actually
   * visible in the viewport is somewhere to land.
   * @param {string|null} playId
   * @returns {HTMLElement|null} the card's photo frame
   */
  function findLanding(playId) {
    if (!playId) return null;
    const sel = `article.play-card[data-play-id="${window.CSS && CSS.escape ? CSS.escape(playId) : playId}"] .play-card__photo`;
    const vh = window.innerHeight;
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh) return el;
    }
    return null;
  }

  /**
   * Where the image actually sits inside the frame. The card's photo is
   * object-fit: contain (never cropped), so landing on the frame itself would
   * finish a letterboxed photo stretched to the frame's edges.
   * @param {HTMLElement} frame
   */
  function landingRect(frame) {
    const r = frame.getBoundingClientRect();
    const img = /** @type {HTMLImageElement|null} */ (frame.querySelector(".play-card__photo-img"));
    if (!img || !img.naturalWidth || !img.naturalHeight) return r;
    const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  }

  /**
   * Close the popup with the photo flying back into its polaroid. Measured
   * before close() runs — the popup's reset clears state the markup reads.
   * @param {HTMLElement} root
   * @param {string|null} playId
   * @param {() => void} close
   */
  function collapse(root, playId, close) {
    const card = root.querySelector(CARD_SEL);
    // The play's own photo, else the game art in the header — which is what the
    // polaroid shows in its photo slot when nobody uploaded one.
    const photo = /** @type {HTMLImageElement|null} */ (card && (
      card.querySelector(".play-detail-popup__photo") ||
      card.querySelector(".play-detail__game-thumb")));
    const frame = findLanding(playId);

    root.classList.add("is-pulled", "is-collapsing");
    root.style.setProperty("--pdp-drag", Math.round(window.innerHeight * 0.6) + "px");

    if (photo && frame && photo.complete && photo.naturalWidth && !reducedMotion()) {
      fly(photo, frame);
    }
    close();
  }

  /**
   * @param {HTMLImageElement} photo
   * @param {HTMLElement} frame
   */
  function fly(photo, frame) {
    const a = photo.getBoundingClientRect();
    const b = landingRect(frame);
    if (!a.width || !a.height) return;

    // A wrapper rather than a bare <img>, so the flyer can carry the shade the
    // polaroid paints over its photo (.play-card__photo::after). Both it and
    // the drop shadow are animated INTO their landed values over the flight —
    // left as fixed styles, the shadow vanished and the shade appeared in the
    // single frame the flyer was swapped for the card, and read as a blink.
    const flyer = document.createElement("div");
    flyer.className = "pdp-flyer";
    flyer.setAttribute("aria-hidden", "true");
    const img = document.createElement("img");
    img.src = photo.currentSrc || photo.src;
    img.alt = "";
    const shade = document.createElement("span");
    shade.className = "pdp-flyer__shade";
    flyer.append(img, shade);
    Object.assign(flyer.style, {
      left: a.left + "px", top: a.top + "px", width: a.width + "px", height: a.height + "px",
    });
    document.body.appendChild(flyer);
    // The original stays in the popup as it drops away; hide it so there is
    // only ever one photo on screen.
    photo.style.visibility = "hidden";

    const box = (r) => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    // The snap: lift a little and swell as it comes off the card, then fall
    // into the polaroid, shrinking and straightening out as it lands. The
    // shadow follows the height: it grows with the lift and settles to nothing
    // as the photo lies flat in the frame, which casts none of its own.
    const lift = { left: a.left + "px", top: (a.top - 14) + "px", width: a.width + "px", height: a.height + "px" };
    const timing = { duration: FLIGHT_MS, easing: "cubic-bezier(.3,.8,.35,1)", fill: /** @type {FillMode} */ ("forwards") };
    const anim = flyer.animate([
      { ...box(a), transform: "scale(1) rotate(0deg)", borderRadius: "8px",
        boxShadow: "0 4px 10px -2px rgba(0, 0, 0, 0.35)", offset: 0 },
      { ...lift, transform: "scale(1.05) rotate(-2.5deg)", borderRadius: "8px",
        boxShadow: "0 22px 40px -12px rgba(0, 0, 0, 0.6)", offset: 0.2, easing: "cubic-bezier(.45,0,.2,1)" },
      { ...box(b), transform: "scale(1) rotate(0deg)", borderRadius: "3px",
        boxShadow: "0 0 0 0 rgba(0, 0, 0, 0)", offset: 1 },
    ], timing);
    shade.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], timing);

    // The flyer now looks exactly like the photo underneath it, so it can go
    // in one frame — a cross-fade here would show the card's thump through a
    // copy that isn't doing it.
    const land = () => {
      flyer.remove();
      frame.classList.remove("is-receiving");
      // Reflow so a second landing on the same card replays the thump.
      void frame.offsetWidth;
      frame.classList.add("is-receiving");
      setTimeout(() => frame.classList.remove("is-receiving"), 360);
    };
    anim.onfinish = land;
    anim.oncancel = () => flyer.remove();
  }

  window.PlayDetailCollapse = { attach };
})();
