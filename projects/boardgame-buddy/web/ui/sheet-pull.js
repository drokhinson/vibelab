// @ts-check
// ui/sheet-pull.js — pull a bottom sheet down to close it.
//
// The panel follows the finger down; past COMMIT_PX, or on a downward flick,
// release slides it the rest of the way off and closes the sheet. Anything
// less springs it back. A drag that starts sideways is left alone, so a
// horizontally scrolling track inside the panel keeps its swipe; one that
// starts inside something scrolled down scrolls that instead.
//
// Touch-only, like widgets/play-detail-collapse.js: Close, a tap outside,
// Escape and the back gesture stay the exits everywhere else.
//
// State lives on the backdrop, as `.is-pulled` plus the custom properties
// --sheet-drag (px) and --sheet-pull (0–1), and styles.css reads them
// (.claude/rules/card-gestures.md §3). `.is-pulled` takes the panel off its
// `sheetIn` entrance, whose fill-mode both would otherwise hold the transform,
// and it stays through BottomSheet.close(), so the .is-closing slide does not
// restart from the top after a pull has already carried the panel off.
//
// API:
//   window.BgbSheetPull.attach(root, { panelSel, close })
//     root     — the sheet backdrop (BottomSheet's el)
//     panelSel — the panel inside it that moves
//     close    — () => void; the sheet's close()

(function () {
  // Below this a move is a tap's jitter, or undecided between down and sideways.
  const SLOP_PX = 8;
  // Pull past this and releasing closes.
  const COMMIT_PX = 110;
  // A short, fast flick closes too — px per ms, over the last move.
  const FLICK_V = 0.55;
  const FLICK_MIN_PX = 36;
  // Must match the .is-settling transition in styles.css.
  const SETTLE_MS = 220;

  /** Is any element between `t` and `panel` scrolled away from its top? */
  function scrolledAbove(t, panel) {
    for (let el = t; el && el !== panel.parentElement; el = el.parentElement) {
      if (el instanceof HTMLElement && el.scrollTop > 0) return true;
    }
    return false;
  }

  /**
   * @param {HTMLElement} root
   * @param {{ panelSel: string, close: () => void }} opts
   */
  function attach(root, opts) {
    if (!("ontouchstart" in window)) return;
    const panel = /** @type {HTMLElement|null} */ (root.querySelector(opts.panelSel));
    if (!panel) return;
    let state = "idle"; // idle | undecided | pulling | ignored
    let x0 = 0, y0 = 0, dy = 0, lastY = 0, lastT = 0, vel = 0;

    const paint = (y) => {
      const d = Math.max(0, y);
      root.style.setProperty("--sheet-drag", `${d}px`);
      root.style.setProperty("--sheet-pull", String(Math.min(1, d / (panel.offsetHeight || 1))));
    };

    root.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || !panel.contains(/** @type {Node} */ (e.target))) {
        state = "ignored";
        return;
      }
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; dy = 0; vel = 0;
      lastY = y0; lastT = e.timeStamp;
      state = scrolledAbove(e.target, panel) ? "ignored" : "undecided";
    }, { passive: true });

    root.addEventListener("touchmove", (e) => {
      if (state === "idle" || state === "ignored") return;
      const t = e.touches[0];
      const dx = t.clientX - x0;
      dy = t.clientY - y0;
      if (state === "undecided") {
        if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
        if (dy <= 0 || Math.abs(dx) >= Math.abs(dy)) { state = "ignored"; return; }
        state = "pulling";
        root.classList.remove("is-settling");
        root.classList.add("is-pulled");
      }
      e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) vel = (t.clientY - lastY) / dt;
      lastY = t.clientY; lastT = e.timeStamp;
      paint(dy);
    }, { passive: false });

    const end = () => {
      if (state !== "pulling") { state = "idle"; return; }
      state = "idle";
      const commit = dy > COMMIT_PX || (dy > FLICK_MIN_PX && vel > FLICK_V);
      root.classList.add("is-settling");
      if (commit) {
        root.style.setProperty("--sheet-drag", "100%");
        root.style.setProperty("--sheet-pull", "1");
        setTimeout(() => opts.close(), SETTLE_MS);
      } else {
        // `.is-pulled` stays: taking it off would hand the panel back to its
        // entrance animation, which would play again.
        paint(0);
        setTimeout(() => {
          if (state === "idle") root.classList.remove("is-settling");
        }, SETTLE_MS);
      }
    };
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", end);
  }

  window.BgbSheetPull = { attach };
})();
