// widgets/play-detail-flight.js — the photo flying between a feed polaroid and
// the play-detail popup, both ways.
//
// The popup is the polaroid "expanded", so its photo travels: on open it lifts
// out of the card and grows into the popup (flyOut), and on pull-to-close it
// lifts off the popup and shrinks back into the card (flyBack). One flyer, one
// set of keyframes run in either direction, so the two read as the same object
// going and coming.
//
// The flyer is fixed above everything, so nothing clips it the way a feed day's
// sideways rail clips the card it belongs to. Whatever of the card is hidden is
// cut off the flyer at the card's end of the flight (visibleRect), and a half
// hidden card is scrolled into view before a landing (reveal).
//
// API (all used by widgets/play-detail-collapse.js and widgets/play-detail-popup.js):
//   PlayDetailFlight.findLanding(playId)   → the visible card's photo frame, or null
//   PlayDetailFlight.reveal(frame)         — scroll a half-hidden card into view
//   PlayDetailFlight.flyBack(photo, frame, root) — popup → card
//   PlayDetailFlight.flyOut(photo, frame, root)  → Promise<void>; card → popup
//     (the box-art badge flies alongside the photo when the play has one)
//   PlayDetailFlight.reducedMotion()

// @ts-check

(function () {
  const BACK_MS = 480;
  const OUT_MS = 420;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /**
   * The polaroid on screen for this play, if any. The router only hides views,
   * so the same play can be mounted in the feed and in a game's reel at once
   * (see rerenderCard in ui/play-card.js) — only a copy that is actually
   * visible in the viewport is somewhere to fly to or from.
   * @param {string|null} playId
   * @returns {HTMLElement|null} the card's photo frame
   */
  function findLanding(playId) {
    if (!playId) return null;
    const sel = `article.play-card[data-play-id="${window.CSS && CSS.escape ? CSS.escape(playId) : playId}"] .play-card__photo`;
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(sel))) {
      const v = visibleRect(el);
      if (v.width > 0 && v.height > 0) return el;
    }
    return null;
  }

  /**
   * The part of an element actually on screen: its box cut down by every
   * ancestor that clips (a feed day's sideways rail, above all) and by the
   * viewport.
   * @param {Element} el
   */
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const q = a.getBoundingClientRect();
      left = Math.max(left, q.left); top = Math.max(top, q.top);
      right = Math.min(right, q.right); bottom = Math.min(bottom, q.bottom);
    }
    left = Math.max(left, 0); top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth); bottom = Math.min(bottom, window.innerHeight);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  /**
   * Bring a half-hidden polaroid fully into view before the photo flies at it,
   * so it lands on a whole card rather than on a sliver at the screen's edge.
   * `inline: "start"` because that is where the rail's mandatory scroll-snap
   * would put it anyway — any other stop gets re-snapped after we have
   * measured. The page is scroll-locked, but not to script, and the popup's
   * backdrop is still covering it.
   * @param {HTMLElement} frame
   */
  function reveal(frame) {
    const r = frame.getBoundingClientRect();
    const v = visibleRect(frame);
    if (v.width >= r.width - 1 && v.height >= r.height - 1) return;
    const card = frame.closest("article.play-card") || frame;
    card.scrollIntoView({ block: "nearest", inline: "start", behavior: "instant" });
  }

  /**
   * Where the image actually sits inside the frame. The card's photo is
   * object-fit: contain (never cropped), so flying to the frame itself would
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
   * Insets (top right bottom left) of the part of `rect` hidden from view —
   * `el` is the element the rect belongs to, whose clipping ancestors decide.
   * @param {Element} el
   * @param {{left:number, top:number, width:number, height:number}} rect
   */
  function hiddenInsets(el, rect) {
    const v = visibleRect(el);
    return [
      Math.max(0, v.top - rect.top), Math.max(0, rect.left + rect.width - v.right),
      Math.max(0, rect.top + rect.height - v.bottom), Math.max(0, v.left - rect.left),
    ];
  }

  // The two things that fly. The photo lands in the polaroid's photo frame,
  // wearing its shade; the box art lands on the framed plate the polaroid lays
  // over a user's photo (.play-card__game-overlay), so it takes the plate's
  // border and shadow on the way down and loses them on the way up.
  const PHOTO = {
    className: "pdp-flyer",
    shade: true,
    popup: { borderRadius: "8px", boxShadow: "0 4px 10px -2px rgba(0, 0, 0, 0.35), 0 0 0 0 rgba(0, 0, 0, 0)" },
    card: { borderRadius: "3px", boxShadow: "0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0)" },
  };
  const BADGE = {
    className: "pdp-flyer pdp-flyer--badge",
    shade: false,
    popup: { borderRadius: "6px", borderWidth: "0px",
      boxShadow: "0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0)" },
    card: { borderRadius: "7px", borderWidth: "2px",
      boxShadow: "0 6px 14px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.18)" },
  };
  const LIFT_SHADOW = "0 22px 40px -12px rgba(0, 0, 0, 0.6), 0 0 0 0 rgba(0, 0, 0, 0)";

  /**
   * Build a flyer and run it between an element in the popup and its twin on
   * the card.
   *
   * The keyframes are written popup → card, and `toCard: false` runs the SAME
   * three stops in reverse, so opening and closing are one motion played both
   * ways: the image lifts and swells off whatever it is leaving, then settles
   * flat into where it is going.
   *
   * Everything that differs between the two ends is animated INTO its resting
   * value rather than set — the drop shadow, the corner radius, the polaroid's
   * shade over its photo, the badge plate's border. A property left fixed on
   * the flyer changes in the one frame it is swapped for the real element, and
   * reads as a blink.
   *
   * Either end can be partly hidden — the card by a sideways rail, the popup's
   * photo by the popup's own scroll — and the flyer is hidden there too, as
   * clip-path insets from that end's box. Only when something IS hidden: a
   * clip-path also cuts the drop shadow, so an open end is a negative inset
   * wide enough for it.
   *
   * @param {HTMLElement} popupEl
   * @param {HTMLElement} cardEl
   * @param {{left:number, top:number, width:number, height:number}} b  the card end's box
   * @param {boolean} toCard
   * @param {typeof PHOTO} kind
   * @returns {{ anim: Animation, flyer: HTMLElement }|null}
   */
  function flight(popupEl, cardEl, b, toCard, kind) {
    const a = popupEl.getBoundingClientRect();
    if (!a.width || !a.height || !b.width || !b.height) return null;
    const insetA = hiddenInsets(popupEl, a);
    const insetB = hiddenInsets(cardEl, b);
    const clipped = insetA.concat(insetB).some((n) => n > 0.5);
    const clip = (ins) => {
      if (!clipped) return {};
      const open = ins.every((n) => n <= 0.5);
      return { clipPath: open ? "inset(-60px -60px -60px -60px)" : `inset(${ins.map((n) => n.toFixed(1) + "px").join(" ")})` };
    };

    const flyer = document.createElement("div");
    flyer.className = kind.className;
    flyer.setAttribute("aria-hidden", "true");
    const src = /** @type {HTMLImageElement} */ (popupEl).currentSrc || /** @type {HTMLImageElement} */ (popupEl).src;
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    flyer.append(img);
    let shade = null;
    if (kind.shade) {
      shade = document.createElement("span");
      shade.className = "pdp-flyer__shade";
      flyer.append(shade);
    }
    const start = toCard ? a : b;
    Object.assign(flyer.style, {
      left: start.left + "px", top: start.top + "px", width: start.width + "px", height: start.height + "px",
    });
    document.body.appendChild(flyer);

    const box = (r, dy = 0) => ({ left: r.left + "px", top: (r.top + dy) + "px", width: r.width + "px", height: r.height + "px" });
    // The lift happens next to whichever end the image is LEAVING, and wears
    // that end's look apart from the raised shadow.
    const leaving = toCard ? kind.popup : kind.card;
    const popupEnd = { ...box(a), transform: "scale(1) rotate(0deg)", ...kind.popup, ...clip(insetA) };
    const lift = { ...box(toCard ? a : b, -14), transform: "scale(1.05) rotate(-2.5deg)", ...leaving, boxShadow: LIFT_SHADOW };
    const cardEnd = { ...box(b), transform: "scale(1) rotate(0deg)", ...kind.card, ...clip(insetB) };
    const frames = toCard
      ? [{ ...popupEnd, offset: 0 }, { ...lift, offset: 0.2, easing: "cubic-bezier(.45,0,.2,1)" }, { ...cardEnd, offset: 1 }]
      : [{ ...cardEnd, offset: 0 }, { ...lift, offset: 0.2, easing: "cubic-bezier(.45,0,.2,1)" }, { ...popupEnd, offset: 1 }];
    const timing = {
      duration: toCard ? BACK_MS : OUT_MS,
      easing: "cubic-bezier(.3,.8,.35,1)",
      fill: /** @type {FillMode} */ ("forwards"),
    };
    const anim = flyer.animate(frames, timing);
    if (shade) {
      shade.animate(toCard
        ? [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }]
        : [{ opacity: 1 }, { opacity: 0, offset: 0.65 }, { opacity: 0 }], timing);
    }
    anim.oncancel = () => flyer.remove();
    return { anim, flyer };
  }

  /**
   * The box-art pair, when the play has a photo of its own: the card lays the
   * game's box art over that photo as a framed badge, and the popup shows it as
   * the thumb in the game row. Without a user photo the box art IS the photo
   * (and is what the main flyer carries), so there is nothing extra to fly.
   * @param {HTMLImageElement} photo
   * @param {HTMLElement} frame
   * @param {HTMLElement} root
   */
  function badgePair(photo, frame, root) {
    if (!photo.classList.contains("play-detail-popup__photo")) return null;
    const thumb = /** @type {HTMLImageElement|null} */ (root.querySelector(".play-detail__game-thumb"));
    const plate = /** @type {HTMLElement|null} */ (frame.querySelector(".play-card__game-overlay"));
    // The thumb's box is fixed by CSS (44px), so a flight can be aimed at it
    // before its pixels have arrived — and on open they usually haven't.
    if (!thumb || !plate) return null;
    return { thumb, plate };
  }

  /**
   * Popup → card, on pull-to-close. The popup's images are hidden for the
   * flight (the popup is dropping away underneath), and the card gives a small
   * thump as the photo lands in it. The card's box-art badge is hidden while
   * its flyer is on the way — otherwise the photo flyer covers it, and it
   * "appears" the moment that flyer is removed — and is shown again in the
   * same frame its own flyer lands on it.
   * @param {HTMLImageElement} photo
   * @param {HTMLElement} frame
   * @param {HTMLElement} root
   */
  function flyBack(photo, frame, root) {
    const pair = badgePair(photo, frame, root);
    const f = flight(photo, frame, landingRect(frame), true, PHOTO);
    if (!f) return;
    photo.style.visibility = "hidden";
    // The flyer now looks exactly like the photo underneath it, so it can go
    // in one frame — a cross-fade here would show the card's thump through a
    // copy that isn't doing it.
    f.anim.onfinish = () => {
      f.flyer.remove();
      frame.classList.remove("is-receiving");
      // Reflow so a second landing on the same card replays the thump.
      void frame.offsetWidth;
      frame.classList.add("is-receiving");
      setTimeout(() => frame.classList.remove("is-receiving"), 360);
    };
    if (!pair) return;
    const g = flight(pair.thumb, pair.plate, pair.plate.getBoundingClientRect(), true, BADGE);
    if (!g) return;
    pair.thumb.style.visibility = "hidden";
    pair.plate.style.visibility = "hidden";
    const land = () => { pair.plate.style.visibility = ""; g.flyer.remove(); };
    g.anim.onfinish = land;
    g.anim.oncancel = land;
  }

  /**
   * Card → popup, on open. The popup's own photo (and box-art thumb) stay
   * hidden until their flyers land on them, then take over in the same frame.
   * The card keeps its own images: it stays where it is behind the blur.
   * @param {HTMLImageElement} photo
   * @param {HTMLElement} frame
   * @param {HTMLElement} root
   * @returns {Promise<void>} settles when the flights are over (or never started)
   */
  function flyOut(photo, frame, root) {
    const pair = badgePair(photo, frame, root);
    /** @type {Promise<void>[]} */
    const flights = [];
    const run = (el, f) => {
      if (!f) return;
      el.style.visibility = "hidden";
      flights.push(new Promise((resolve) => {
        const done = () => { el.style.visibility = ""; f.flyer.remove(); resolve(); };
        f.anim.onfinish = done;
        f.anim.oncancel = done;
      }));
    };
    run(photo, flight(photo, frame, landingRect(frame), false, PHOTO));
    if (pair) run(pair.thumb, flight(pair.thumb, pair.plate, pair.plate.getBoundingClientRect(), false, BADGE));
    return Promise.all(flights).then(() => {});
  }

  window.PlayDetailFlight = { findLanding, reveal, flyBack, flyOut, reducedMotion };
})();
