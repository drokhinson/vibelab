// widgets/play-detail-pager.js — swipe left and right through neighbouring plays
// from inside the play-detail popup.
//
// The popup opens from a list of polaroids (the feed, a game's plays reel), and
// the next thing a person reading one play usually wants is the one beside it.
// Closing and re-tapping costs two taps and an animation per play; paging costs a
// swipe. So the popup captures the list it was opened from, and a horizontal drag
// on the card carries it off the side and brings the neighbour in.
//
// THE SEQUENCE IS THE SET THE TAPPED CARD SITS IN — the cards of its own
// .play-session__scroll row, in DOM order: one table's evening in the feed ("You,
// JasBot and 2 others played 2 games"), or a game's plays reel. Paging walks that
// row and stops at its ends; it never crosses into the next session, because a
// play logged on its own is a separate thing to open, not the next page of this
// one. A single play is a set of one. Run cards (play-card--stack) are left out:
// they open a sheet, not this popup. An open from somewhere with no polaroid for
// the play — a notification, the plays log — is a set of one too, and nothing
// here draws or listens.
//
// The drag offset is a custom property on the backdrop, like the pull-to-close
// one in widgets/play-detail-collapse.js and for the same reason: the card itself
// is rewritten by BgbDomPatch on every repaint.
//
// API:
//   PlayDetailPager.sequenceFor(playId)          → string[] (always includes playId)
//   PlayDetailPager.renderNav(index, total)      → topbar markup, "" for one play
//   PlayDetailPager.attach(root, { canSwipe, step })
//     canSwipe — (dir: 1|-1) => boolean; false at an end, while editing, …
//     step     — (dir: 1|-1) => void; show the neighbour (the popup's goTo)
//   PlayDetailPager.slide(root, dir, swap)       — the animated page turn

// @ts-check

(function () {
  const SLOP_PX = 8;
  // A page turn needs a deliberate drag or a flick — the card is also a place
  // people rest a thumb while reading.
  const COMMIT_PX = 72;
  const FLICK_V = 0.5;
  const FLICK_MIN_PX = 28;
  // Must match .is-paging-out / .is-settling in styles.css.
  const OUT_MS = 170;
  const IN_MS = 240;

  const CARD_SEL = ".play-detail-popup__card";

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /** @param {Element} el */
  const visible = (el) => el.getClientRects().length > 0;

  /**
   * The ids of the polaroids in this one's set, in reading order.
   * @param {string} playId
   * @returns {string[]}
   */
  function sequenceFor(playId) {
    const esc = window.CSS && CSS.escape ? CSS.escape(playId) : playId;
    // The router only hides views, so the same play can be mounted in a hidden
    // one too; the tapped copy is the visible one.
    const own = Array.from(document.querySelectorAll(`article.play-card[data-play-id="${esc}"]`))
      .find(visible);
    if (!own) return [playId];
    const scope = own.closest(".play-session__scroll");
    if (!scope) return [playId];
    const ids = [];
    for (const el of scope.querySelectorAll("article.play-card[data-play-id]:not(.play-card--stack)")) {
      const id = el.getAttribute("data-play-id");
      if (id && visible(el) && ids.indexOf(id) === -1) ids.push(id);
    }
    return ids.indexOf(playId) === -1 ? [playId] : ids;
  }

  /**
   * Prev / next arrows and "3 of 12" for the popup's top bar. The arrows are the
   * whole feature for a mouse and a keyboard, and the count is how a touch user
   * learns there is anything to swipe to.
   * @param {number} index
   * @param {number} total
   */
  function renderNav(index, total) {
    if (total < 2) return `<span></span>`;
    const btn = (dir, icon, label, off) => `
      <button class="play-detail-popup__page" type="button" aria-label="${label}"
              ${off ? "disabled" : ""}
              onclick="window.PlayDetailPopup._page(${dir})">
        <i data-icon="${icon}" class="w-4 h-4"></i>
      </button>`;
    return `
      <div class="play-detail-popup__pager">
        ${btn(-1, "chevron-left", "Previous play", index <= 0)}
        <span class="play-detail-popup__page-count">${index + 1} of ${total}</span>
        ${btn(1, "chevron-right", "Next play", index >= total - 1)}
      </div>`;
  }

  /**
   * Is anything between the touch and the card a sideways scroller? The rounds
   * grid is, and a drag across it is reading the grid, not turning the page.
   * @param {Element} t
   */
  function inSideScroller(t) {
    for (let el = /** @type {Element|null} */ (t); el && !el.matches(CARD_SEL); el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
    }
    return false;
  }

  /** @param {HTMLElement} root @param {number} px */
  function paint(root, px) {
    root.style.setProperty("--pdp-dx", px.toFixed(1) + "px");
  }

  /**
   * The page turn: the card leaves on the side the finger was going, the next
   * play is swapped in off-screen on the other side, and it slides to centre.
   * @param {HTMLElement} root
   * @param {1|-1} dir  1 = next (the card leaves to the left)
   * @param {() => void} swap
   */
  function slide(root, dir, swap) {
    root.classList.add("is-pulled");
    root.classList.remove("is-settling");
    if (reducedMotion()) { swap(); paint(root, 0); return; }
    const w = window.innerWidth;
    root.classList.add("is-paging-out");
    paint(root, -dir * w);
    setTimeout(() => {
      root.classList.remove("is-paging-out");
      swap();
      paint(root, dir * w);
      void root.offsetWidth;   // commit the off-screen start before transitioning
      root.classList.add("is-settling");
      paint(root, 0);
      setTimeout(() => root.classList.remove("is-settling"), IN_MS);
    }, OUT_MS);
  }

  /**
   * @param {HTMLElement} root
   * @param {{ canSwipe: (dir: 1|-1) => boolean, step: (dir: 1|-1) => void }} opts
   */
  function attach(root, opts) {
    // Arrow keys everywhere; the drag only where there is a finger.
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = /** @type {Element} */ (e.target);
      if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (!opts.canSwipe(dir)) return;
      e.preventDefault();
      opts.step(dir);
    });

    if (!("ontouchstart" in window)) return;
    let tracking = false, drawing = false;
    let x0 = 0, y0 = 0, dx = 0, lastX = 0, lastT = 0, vel = 0;

    root.addEventListener("touchstart", (e) => {
      tracking = false;
      if (e.touches.length !== 1) return;
      if (root.classList.contains("is-collapsing") || root.classList.contains("is-paging-out")) return;
      const t = /** @type {Element} */ (e.target);
      if (!t.closest || !t.closest(CARD_SEL) || t.closest("input, textarea, select")) return;
      if (!opts.canSwipe(1) && !opts.canSwipe(-1)) return;
      if (inSideScroller(t)) return;
      tracking = true;
      drawing = false;
      x0 = lastX = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      lastT = e.timeStamp;
      vel = 0;
    }, { passive: true });

    root.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const ddx = t.clientX - x0;
      const ddy = t.clientY - y0;
      if (!drawing) {
        if (Math.abs(ddx) < SLOP_PX && Math.abs(ddy) < SLOP_PX) return;
        // Vertical is the card's scroll, or the pull-to-close — not ours.
        if (Math.abs(ddy) >= Math.abs(ddx)) { tracking = false; return; }
        drawing = true;
        root.classList.remove("is-settling");
        root.classList.add("is-pulled");
        x0 = t.clientX;
      }
      e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) vel = 0.6 * ((t.clientX - lastX) / dt) + 0.4 * vel;
      lastX = t.clientX;
      lastT = e.timeStamp;
      dx = t.clientX - x0;
      // Past either end the card still moves, but reluctantly — it says "that's
      // the last one" rather than ignoring the finger.
      const dir = dx < 0 ? 1 : -1;
      paint(root, opts.canSwipe(dir) ? dx : dx * 0.25);
    }, { passive: false });

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!drawing) return;
      drawing = false;
      const dir = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) >= COMMIT_PX;
      const flick = Math.abs(vel) >= FLICK_V && Math.abs(dx) >= FLICK_MIN_PX && Math.sign(vel) === Math.sign(dx);
      if ((far || flick) && opts.canSwipe(dir)) {
        opts.step(dir);
        return;
      }
      root.classList.add("is-settling");
      paint(root, 0);
      setTimeout(() => root.classList.remove("is-settling"), IN_MS);
    };
    root.addEventListener("touchend", end, { passive: true });
    root.addEventListener("touchcancel", end, { passive: true });
  }

  window.PlayDetailPager = { sequenceFor, renderNav, attach, slide };
})();
