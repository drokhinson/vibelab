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
//   PlayDetailFlight.flyBack(photo, frame) — popup photo → card
//   PlayDetailFlight.flyOut(photo, frame)  → Promise<void>; card → popup photo
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
   * Build the flyer and run it between the popup photo's box and the card's.
   *
   * The keyframes are written popup → card, and `toCard: false` runs the SAME
   * three stops in reverse, so opening and closing are one motion played both
   * ways: the photo lifts and swells off whatever it is leaving, then settles
   * flat into where it is going.
   *
   * Two things are animated INTO their resting values rather than set: the drop
   * shadow (the popup photo casts a small one, the card's photo none) and the
   * shade the polaroid paints over its photo (.play-card__photo::after). Left as
   * fixed styles they changed in the one frame the flyer was swapped for the
   * real photo, and read as a blink.
   *
   * @param {HTMLImageElement} photo  the popup's photo (or game thumb)
   * @param {HTMLElement} frame       the card's .play-card__photo
   * @param {boolean} toCard
   * @returns {{ anim: Animation, flyer: HTMLElement }|null}
   */
  function flight(photo, frame, toCard) {
    const a = photo.getBoundingClientRect();
    const b = landingRect(frame);
    if (!a.width || !a.height || !b.width || !b.height) return null;
    // Whatever of the card is hidden (a card too wide for its rail, a rail at
    // the end of its travel) is hidden on the flyer too, as insets from the
    // card-end box. Only when something IS hidden: a clip-path also cuts the
    // drop shadow, so the open end is a negative inset wide enough for it.
    const v = visibleRect(frame);
    const insets = [
      Math.max(0, v.top - b.top), Math.max(0, b.left + b.width - v.right),
      Math.max(0, b.top + b.height - v.bottom), Math.max(0, v.left - b.left),
    ];
    const clipped = insets.some((n) => n > 0.5);
    const clipPopup = clipped ? { clipPath: "inset(-60px -60px -60px -60px)" } : {};
    const clipCard = clipped ? { clipPath: `inset(${insets.map((n) => n.toFixed(1) + "px").join(" ")})` } : {};

    const flyer = document.createElement("div");
    flyer.className = "pdp-flyer";
    flyer.setAttribute("aria-hidden", "true");
    const img = document.createElement("img");
    img.src = photo.currentSrc || photo.src;
    img.alt = "";
    const shade = document.createElement("span");
    shade.className = "pdp-flyer__shade";
    flyer.append(img, shade);
    const start = toCard ? a : b;
    Object.assign(flyer.style, {
      left: start.left + "px", top: start.top + "px", width: start.width + "px", height: start.height + "px",
    });
    document.body.appendChild(flyer);

    const box = (r, dy = 0) => ({ left: r.left + "px", top: (r.top + dy) + "px", width: r.width + "px", height: r.height + "px" });
    // The lift happens next to whichever end the photo is LEAVING.
    const liftFrom = toCard ? a : b;
    const popupEnd = { ...box(a), transform: "scale(1) rotate(0deg)", borderRadius: "8px",
      boxShadow: "0 4px 10px -2px rgba(0, 0, 0, 0.35)", ...clipPopup };
    const lift = { ...box(liftFrom, -14), transform: "scale(1.05) rotate(-2.5deg)", borderRadius: toCard ? "8px" : "3px",
      boxShadow: "0 22px 40px -12px rgba(0, 0, 0, 0.6)" };
    const cardEnd = { ...box(b), transform: "scale(1) rotate(0deg)", borderRadius: "3px",
      boxShadow: "0 0 0 0 rgba(0, 0, 0, 0)", ...clipCard };
    const frames = toCard
      ? [{ ...popupEnd, offset: 0 }, { ...lift, offset: 0.2, easing: "cubic-bezier(.45,0,.2,1)" }, { ...cardEnd, offset: 1 }]
      : [{ ...cardEnd, offset: 0 }, { ...lift, offset: 0.2, easing: "cubic-bezier(.45,0,.2,1)" }, { ...popupEnd, offset: 1 }];
    const timing = {
      duration: toCard ? BACK_MS : OUT_MS,
      easing: "cubic-bezier(.3,.8,.35,1)",
      fill: /** @type {FillMode} */ ("forwards"),
    };
    const anim = flyer.animate(frames, timing);
    shade.animate(toCard
      ? [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }]
      : [{ opacity: 1 }, { opacity: 0, offset: 0.65 }, { opacity: 0 }], timing);
    anim.oncancel = () => flyer.remove();
    return { anim, flyer };
  }

  /**
   * Popup photo → card, on pull-to-close. The popup photo is hidden for the
   * flight (the popup is dropping away underneath), and the card gives a small
   * thump as the photo lands in it.
   * @param {HTMLImageElement} photo
   * @param {HTMLElement} frame
   */
  function flyBack(photo, frame) {
    const f = flight(photo, frame, true);
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
  }

  /**
   * Card → popup photo, on open. The popup's own photo stays hidden until the
   * flyer lands on it, then takes over in the same frame.
   * @param {HTMLImageElement} photo
   * @param {HTMLElement} frame
   * @returns {Promise<void>} settles when the flight is over (or never started)
   */
  function flyOut(photo, frame) {
    const f = flight(photo, frame, false);
    if (!f) return Promise.resolve();
    photo.style.visibility = "hidden";
    return new Promise((resolve) => {
      const done = () => {
        photo.style.visibility = "";
        f.flyer.remove();
        resolve();
      };
      f.anim.onfinish = done;
      f.anim.oncancel = done;
    });
  }

  window.PlayDetailFlight = { findLanding, reveal, flyBack, flyOut, reducedMotion };
})();
