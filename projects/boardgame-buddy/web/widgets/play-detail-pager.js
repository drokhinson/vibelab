// widgets/play-detail-pager.js — swipe left and right through neighbouring plays
// from inside the play-detail popup.
//
// The popup opens from a list of polaroids (the feed, a game's plays reel), and
// the next thing a person reading one play usually wants is the one beside it.
// Closing and re-tapping costs two taps and an animation per play; paging costs a
// swipe. So the popup captures the list it was opened from, and a horizontal drag
// on the card carries it off the side while the neighbour follows it in.
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
//   PlayDetailPager.preload(urls)                — warm the set's images on open
//   PlayDetailPager.attach(root, { canSwipe, neighbour, peekHtml, swap }) → { turn, clear }
//     canSwipe  — (dir: 1|-1) => boolean; false at an end, while editing, …
//     neighbour — (dir: 1|-1) => the play id on that side, or null
//     peekHtml  — (id) => that play's card markup, exactly as the popup paints it
//     swap      — (id) => load that play into the real card, synchronously

// @ts-check

(function () {
  const SLOP_PX = 8;
  // A page turn needs a deliberate drag or a flick — the card is also a place
  // people rest a thumb while reading.
  const COMMIT_PX = 72;
  const FLICK_V = 0.5;
  const FLICK_MIN_PX = 28;
  // Must match .is-turning in styles.css.
  const TURN_MS = 220;
  const TURN_EASE = "cubic-bezier(.22, .61, .36, 1)";
  // Between the card and a neighbour waiting beside it.
  const GAP_PX = 16;

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

  /**
   * Warm the image cache for every play in the set the moment the popup opens.
   * The feed's polaroids are loading="lazy", so the cards of a set scrolled off
   * the side of its rail have never been fetched — and a page turn, which slides
   * the neighbour in while the finger is still down, has no time to wait for
   * one. decode() as well as fetch, so the first paint of a photo is not also
   * its first decode.
   * @param {string[]} urls
   */
  function preload(urls) {
    const seen = new Set();
    for (const u of urls) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      const img = new Image();
      img.decoding = "async";
      img.src = u;
      if (img.decode) img.decode().catch(() => {});
    }
  }

  /**
   * Wire the gesture, the arrows and the keys to one page turn.
   *
   * THE NEIGHBOURS ARE ON SCREEN WHILE THE FINGER MOVES. The moment a sideways
   * drag starts, a copy of each neighbouring play's card is laid beside the real
   * one — the same markup the popup would paint for it — and travels with it, so
   * the next play slides in under the thumb instead of appearing after the old
   * one has gone. On commit the real card and the incoming copy finish the
   * slide together; then, in one frame, the popup loads the neighbour into the
   * real card at centre and the copies are removed. Same markup, same place,
   * photo already decoded: the swap is invisible.
   *
   * The copies are body-level, not inside the backdrop: the backdrop is the
   * morph root of the popup's render(), and a revalidation landing mid-drag
   * would delete a child it did not paint.
   *
   * @param {HTMLElement} root
   * @param {{
   *   canSwipe: (dir: 1|-1) => boolean,
   *   neighbour: (dir: 1|-1) => (string|null),
   *   peekHtml: (id: string) => string,
   *   swap: (id: string) => void,
   * }} opts
   */
  function attach(root, opts) {
    /** @type {Record<string, HTMLElement>} */
    let ghosts = {};
    let offset = 0;       // card width + gap: where a neighbour waits
    let busy = false;     // a turn or a spring-back is animating
    let timer = /** @type {any} */ (0);

    const card = () => /** @type {HTMLElement|null} */ (root.querySelector(CARD_SEL));

    function clear() {
      clearTimeout(timer);
      for (const k in ghosts) ghosts[k].remove();
      ghosts = {};
      busy = false;
      root.classList.remove("is-turning");
    }

    function makeGhosts() {
      clear();
      const c = card();
      if (!c) return;
      // Measured with the card at rest (paint(0) precedes every call), so the
      // rect is where the incoming card will sit once it has arrived.
      const r = c.getBoundingClientRect();
      offset = r.width + GAP_PX;
      for (const dir of /** @type {Array<1|-1>} */ ([-1, 1])) {
        const id = opts.neighbour(dir);
        if (!id) continue;
        const tmp = document.createElement("div");
        tmp.innerHTML = opts.peekHtml(id);
        const g = /** @type {HTMLElement|null} */ (tmp.firstElementChild);
        if (!g) continue;
        g.classList.add("play-detail-popup__card--peek");
        g.removeAttribute("role");
        g.removeAttribute("aria-modal");
        g.setAttribute("aria-hidden", "true");
        g.inert = true;
        Object.assign(g.style, {
          left: r.left + "px", top: r.top + "px", width: r.width + "px",
          transform: `translateX(${dir * offset}px)`,
        });
        document.body.appendChild(g);
        if (window.BgbIcons) window.BgbIcons.render(g);
        ghosts[dir] = g;
      }
    }

    /** @param {number} dx */
    function paint(dx) {
      root.style.setProperty("--pdp-dx", dx.toFixed(1) + "px");
      for (const k in ghosts) {
        ghosts[k].style.transform = `translateX(${(dx + Number(k) * offset).toFixed(1)}px)`;
      }
    }

    /** Animate everything to `dx`, then run `after`. */
    function animateTo(dx, after) {
      busy = true;
      root.classList.add("is-pulled", "is-turning");
      for (const k in ghosts) ghosts[k].style.transition = `transform ${TURN_MS}ms ${TURN_EASE}`;
      paint(dx);
      timer = setTimeout(() => {
        root.classList.remove("is-turning");
        for (const k in ghosts) ghosts[k].style.transition = "";
        after();
      }, TURN_MS);
    }

    /** @param {1|-1} dir  1 = next (the card leaves to the left) */
    function turn(dir) {
      if (busy || !opts.canSwipe(dir)) return;
      const id = opts.neighbour(dir);
      if (!id) return;
      if (reducedMotion()) { clear(); opts.swap(id); return; }
      if (!ghosts[dir]) { paint(0); makeGhosts(); void root.offsetWidth; }
      animateTo(-dir * offset, () => {
        opts.swap(id);   // renders the neighbour into the real card, synchronously
        paint(0);        // …which is now back at centre with no transition
        clear();
      });
    }

    function springBack() {
      animateTo(0, clear);
    }

    // Arrow keys everywhere; the drag only where there is a finger.
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = /** @type {Element} */ (e.target);
      if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (!opts.canSwipe(dir)) return;
      e.preventDefault();
      turn(dir);
    });

    const ctl = { turn, clear };
    if (!("ontouchstart" in window)) return ctl;

    let tracking = false, drawing = false;
    let x0 = 0, y0 = 0, dx = 0, lastX = 0, lastT = 0, vel = 0;

    root.addEventListener("touchstart", (e) => {
      tracking = false;
      if (e.touches.length !== 1 || busy) return;
      if (root.classList.contains("is-collapsing")) return;
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
        root.classList.add("is-pulled");
        paint(0);
        makeGhosts();
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
      paint(opts.canSwipe(dir) ? dx : dx * 0.25);
    }, { passive: false });

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!drawing) return;
      drawing = false;
      const dir = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) >= COMMIT_PX;
      const flick = Math.abs(vel) >= FLICK_V && Math.abs(dx) >= FLICK_MIN_PX && Math.sign(vel) === Math.sign(dx);
      if ((far || flick) && opts.canSwipe(dir)) turn(dir);
      else springBack();
    };
    root.addEventListener("touchend", end, { passive: true });
    root.addEventListener("touchcancel", end, { passive: true });

    return ctl;
  }

  window.PlayDetailPager = { sequenceFor, renderNav, attach, preload };
})();
