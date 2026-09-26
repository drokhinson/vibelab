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
//   PlayDetailPager.attach(root, { canSwipe, neighbour, current, peekHtml, swap })
//     → { turn, clear, sync }
//     canSwipe  — (dir: 1|-1) => boolean; false at an end, while editing, …
//     neighbour — (dir: 1|-1) => the play id on that side, or null
//     current   — () => the play id on screen
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
  // A neighbour at rest: smaller and dimmer, so the centre card leads.
  const PEEK_SCALE = 0.85;
  const PEEK_OPACITY = 0.65;
  // The card's own entrance length, and the modal's exit (CLOSE_MS).
  const FADE_IN_MS = 280;
  const FADE_OUT_MS = 200;

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
      if (img.decode) img.decode().then(() => learn(img), () => {});
    }
  }

  // Natural sizes of every image seen, by absolute URL. A copy's <img> is a new
  // element, and a new element is not "complete" in the frame it is inserted
  // even for a cached, decoded image — it lays out 0px tall until it loads, so
  // a copy of a card built at the moment of a turn came out a photo shorter
  // than the card it was replacing. Stamping the known ratio as aspect-ratio
  // reserves the box before the pixels. Not width/height attributes: those
  // pin the natural width, where the popup's photo takes the card's width by
  // stretching, and the copy came out as much too tall as it had been too short.
  /** @type {Map<string, [number, number]>} */
  const sizes = new Map();

  /** @param {HTMLImageElement} img */
  function learn(img) {
    if (img.complete && img.naturalWidth) sizes.set(img.currentSrc || img.src, [img.naturalWidth, img.naturalHeight]);
  }

  /** @param {Element} el */
  function reserveImages(el) {
    for (const img of /** @type {NodeListOf<HTMLImageElement>} */ (el.querySelectorAll("img"))) {
      const wh = sizes.get(img.src);
      if (wh && !img.style.aspectRatio) img.style.aspectRatio = `${wh[0]} / ${wh[1]}`;
    }
  }

  /**
   * Wire the gesture, the arrows, the keys and a tap on a peek to one page turn.
   *
   * THE NEIGHBOURS ARE ALWAYS THERE. A copy of each neighbouring play's card —
   * the exact markup the popup paints for it — sits beside the real one for as
   * long as the popup is open, smaller and dimmer the further it is from centre,
   * so the set reads as a carousel. On a phone the copies wait just off-screen;
   * on a tablet they show as half cards at the edges. They are never created or
   * destroyed where they can be seen: they fade in when the popup opens (or when
   * editing ends), fade out when it closes, and a turn rebuilds them only at
   * positions where identical content is already sitting. Building them on drag
   * start and dropping them after each turn — the first version — made them
   * blink in and out on an iPad, where "off to the side" is on screen.
   *
   * A turn: the real card and every copy move one slot together, the incoming
   * copy growing to full size at centre and the real card shrinking into the
   * slot it vacated. Then, in one frame, the popup loads the neighbour into the
   * real card at centre, a copy of the play just left takes the real card's
   * place in the side slot (its scroll offset carried over), the next play along
   * fades into the far slot, and the old copies go.
   *
   * The copies are body-level, not inside the backdrop: the backdrop is the
   * morph root of the popup's render(), and a revalidation would delete a child
   * it did not paint.
   *
   * @param {HTMLElement} root
   * @param {{
   *   canSwipe: (dir: 1|-1) => boolean,
   *   neighbour: (dir: 1|-1) => (string|null),
   *   current: () => (string|null),
   *   peekHtml: (id: string) => string,
   *   swap: (id: string) => void,
   * }} opts
   */
  function attach(root, opts) {
    /** @type {Record<string, { el: HTMLElement, id: string }>} */
    let peeks = {};
    // Where the real card sits at rest, and where a neighbour waits.
    let geo = null;
    let busy = false;      // a turn or a spring-back is animating
    let drawing = false;   // a finger is dragging the carousel
    let timer = /** @type {any} */ (0);

    const card = () => /** @type {HTMLElement|null} */ (root.querySelector(CARD_SEL));

    /**
     * The real card's layout box, from offsets rather than
     * getBoundingClientRect: the card may be mid-entrance (a 20px rise) or mid
     * drag, and a transform must not become where the neighbours live.
     */
    function measure() {
      const c = card();
      if (!c) return null;
      const rr = root.getBoundingClientRect();
      const width = c.offsetWidth;
      return {
        left: rr.left + c.offsetLeft,
        top: rr.top + c.offsetTop,
        width,
        height: c.offsetHeight,
        // Centred cards (tablet and up, styles.css) share one centre line
        // whatever their height; top-aligned ones (phones) share a top edge.
        centred: getComputedStyle(root).alignItems === "center",
        // At least clear of the card at peek scale; on a wide screen, centred
        // on the screen's edge so half of it shows.
        offset: Math.max(width / 2 + (PEEK_SCALE * width) / 2 + GAP_PX, window.innerWidth / 2),
      };
    }

    /** Scale and opacity for a card `x` px from centre. */
    function look(x) {
      const t = geo ? Math.min(1, Math.abs(x) / geo.offset) : 0;
      return { scale: 1 - (1 - PEEK_SCALE) * t, opacity: 1 - (1 - PEEK_OPACITY) * t };
    }

    /**
     * Pin a copy to the real card's column and to its line: its top edge on a
     * phone, its centre line on a tablet. The centre is held by a -50% translate
     * (paint), not by a top computed from the copy's height — that height is
     * not final until the copy's photo has laid out, and a copy placed from its
     * first measurement drifted off the centre line as its image arrived.
     * @param {HTMLElement} el
     */
    function place(el) {
      if (!geo) return;
      el.style.left = geo.left + "px";
      el.style.width = geo.width + "px";
      el.style.top = (geo.centred ? geo.top + geo.height / 2 : geo.top) + "px";
    }

    /**
     * @param {string} id
     * @param {1|-1} dir
     * @param {boolean} fadeIn
     */
    function makePeek(id, dir, fadeIn) {
      const tmp = document.createElement("div");
      tmp.innerHTML = opts.peekHtml(id);
      const el = /** @type {HTMLElement|null} */ (tmp.firstElementChild);
      if (!el) return null;
      el.classList.add("play-detail-popup__card--peek");
      el.removeAttribute("role");
      el.removeAttribute("aria-modal");
      el.setAttribute("aria-hidden", "true");
      el.dataset.peekId = id;
      // Its contents are a picture of a card, not a card: nothing in it can be
      // focused or pressed. `inert` on the children rather than the copy, so
      // the copy itself still takes the tap that turns to it.
      for (const child of Array.from(el.children)) /** @type {HTMLElement} */ (child).inert = true;
      reserveImages(el);
      el.addEventListener("click", () => turn(dir));
      document.body.appendChild(el);
      if (window.BgbIcons) window.BgbIcons.render(el);
      place(el);
      if (fadeIn && !reducedMotion()) {
        const x = dir * (geo ? geo.offset : 0);
        el.animate([{ opacity: 0 }, { opacity: look(x).opacity }], { duration: FADE_IN_MS, easing: "ease-out" });
      }
      return { el, id };
    }

    /** @param {HTMLElement} el */
    function fadeOut(el) {
      if (reducedMotion()) { el.remove(); return; }
      const a = el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }],
        { duration: FADE_OUT_MS, easing: "ease-in", fill: "forwards" });
      a.onfinish = () => el.remove();
    }

    /** @param {number} dx */
    function paint(dx) {
      const me = look(dx);
      root.style.setProperty("--pdp-dx", dx.toFixed(1) + "px");
      root.style.setProperty("--pdp-scale", me.scale.toFixed(4));
      root.style.setProperty("--pdp-fade", me.opacity.toFixed(3));
      if (!geo) return;
      for (const k in peeks) {
        const x = dx + Number(k) * geo.offset;
        const l = look(x);
        peeks[k].el.style.transform =
          `translate(${x.toFixed(1)}px, ${geo.centred ? "-50%" : "0px"}) scale(${l.scale.toFixed(4)})`;
        peeks[k].el.style.opacity = l.opacity.toFixed(3);
      }
    }

    /**
     * Make the copies match what the popup is showing: one per neighbour it
     * can turn to, none while it cannot (editing, saving, covered). Idempotent
     * — render() calls it after every repaint — and a no-op mid-gesture, whose
     * own ending re-runs it.
     * @param {{ force?: boolean }} [o]  re-measure (a resize, a rotation)
     */
    function sync(o) {
      if (busy || drawing || !root.isConnected) return;
      root.querySelectorAll("img").forEach((img) => learn(/** @type {HTMLImageElement} */ (img)));
      if (!geo || (o && o.force)) {
        geo = measure();
        if (!geo) return;
        for (const k in peeks) place(peeks[k].el);
      }
      for (const dir of /** @type {Array<1|-1>} */ ([-1, 1])) {
        const want = opts.canSwipe(dir) ? opts.neighbour(dir) : null;
        const have = peeks[dir];
        if (have && have.id === want) continue;
        if (have) { fadeOut(have.el); delete peeks[dir]; }
        if (want) {
          const made = makePeek(want, dir, true);
          if (made) peeks[dir] = made;
        }
      }
      paint(0);
    }

    /** @param {{ fade?: boolean }} [o] */
    function clear(o) {
      clearTimeout(timer);
      for (const k in peeks) {
        if (o && o.fade) fadeOut(peeks[k].el);
        else peeks[k].el.remove();
      }
      peeks = {};
      busy = false;
      drawing = false;
      root.classList.remove("is-turning", "is-swiping");
    }

    /**
     * Animate everything to `dx`, then run `after`. Finishes on the card's own
     * transitionend — a timer set to the duration can fire a frame before the
     * last one is painted, and the swap then snaps a copy the final few px.
     * The timer is only the backstop for a transition that never runs (nothing
     * to move, a hidden tab).
     */
    function animateTo(dx, after) {
      busy = true;
      root.classList.add("is-pulled", "is-swiping", "is-turning");
      const tr = `transform ${TURN_MS}ms ${TURN_EASE}, opacity ${TURN_MS}ms ${TURN_EASE}`;
      for (const k in peeks) peeks[k].el.style.transition = tr;
      const c = card();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (c) c.removeEventListener("transitionend", onEnd);
        root.classList.remove("is-turning");
        for (const k in peeks) peeks[k].el.style.transition = "";
        after();
        busy = false;
      };
      const onEnd = (/** @type {TransitionEvent} */ e) => {
        if (e.target === c && e.propertyName === "transform") finish();
      };
      if (c) c.addEventListener("transitionend", onEnd);
      paint(dx);
      timer = setTimeout(finish, TURN_MS + 120);
    }

    /** @param {1|-1} dir  1 = next (the card leaves to the left) */
    function turn(dir) {
      if (busy || !opts.canSwipe(dir)) return;
      const id = opts.neighbour(dir);
      const leaving = opts.current();
      if (!id || !leaving) return;
      if (reducedMotion()) {
        clear();
        busy = true; opts.swap(id); busy = false;
        sync();
        return;
      }
      if (!geo) geo = measure();
      if (!geo) return;
      animateTo(-dir * geo.offset, () => {
        const scroller = card() && card().querySelector(".play-detail-popup__scroll");
        const scrollTop = scroller ? scroller.scrollTop : 0;
        const old = peeks;
        peeks = {};
        // busy is still set, so the render() inside swap() does not sync.
        opts.swap(id);
        // The play just left, where the real card has just shrunk to…
        const back = makePeek(leaving, /** @type {1|-1} */ (-dir), false);
        if (back) {
          peeks[-dir] = back;
          const s = back.el.querySelector(".play-detail-popup__scroll");
          if (s) s.scrollTop = scrollTop;
        }
        // …and the next one along, arriving in the far slot.
        const further = opts.canSwipe(dir) ? opts.neighbour(dir) : null;
        if (further) {
          const f = makePeek(further, dir, true);
          if (f) peeks[dir] = f;
        }
        paint(0);
        for (const k in old) old[k].el.remove();
        root.classList.remove("is-swiping");
      });
    }

    function springBack() {
      animateTo(0, () => root.classList.remove("is-swiping"));
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

    // A rotation or a window resize moves the card, and may change the layout
    // tier that decides whether cards are centred.
    const onResize = () => {
      if (!root.isConnected) { window.removeEventListener("resize", onResize); return; }
      sync({ force: true });
    };
    window.addEventListener("resize", onResize);

    const ctl = { turn, clear, sync };
    if (!("ontouchstart" in window)) return ctl;

    let tracking = false;
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
        sync();   // normally a no-op: the peeks are already in place
        drawing = true;
        root.classList.add("is-pulled", "is-swiping");
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
