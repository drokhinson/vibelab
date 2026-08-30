// ui/dropdown-fit.js — size an absolutely-positioned combo dropdown to the
// space actually on screen, and flip it above its input when there isn't any.
//
// Why this exists: the GameFinder anchors its <ul> at `top: 100%` with a CSS
// max-height. That works while the input sits high in the viewport and
// silently fails when it doesn't — the list is `position: absolute`, so it
// does not extend the page and the rows past the fold are simply unreachable.
// The taller, easier-to-hit rows made that failure mode more likely, not less,
// so the two ship together.
//
// The Gather screen's two combos, which is what this was written for, are both
// bottom sheets now: a sheet is position:fixed and sized off --bgb-vv-h, so
// there is no fold to measure against. What is left is the finder in
// .add-game-modal, and the finder mounted WITHOUT `inlineDropdown`.
//
// CSS keeps the ceiling. This only ever shrinks a dropdown below its own
// max-height or flips it to the other side of the input, so a context that
// wants a tighter list (e.g. .add-game-modal, centred on a backdrop that
// doesn't scroll) says so in the stylesheet and nothing here needs to know.
//
// The visible box comes from window.visualViewport (see ui/viewport-lock.js
// for why: iOS Safari overlays the keyboard without shrinking the layout
// viewport, so innerHeight would happily hand back space the keyboard covers).
// Browsers without it fall back to innerHeight.
//
// Used by: widgets/game-finder.js (overlay form only).

// @ts-check

(function () {
  const GAP = 10;   // breathing room between the list edge and the viewport
  const MIN = 132;  // below this a dropdown is a keyhole — flip instead

  /**
   * @param {Element|null} ddEl      The dropdown <ul> (position: absolute).
   * @param {Element|null} anchorEl  The combo wrapper it's positioned against.
   */
  function fit(ddEl, anchorEl) {
    const dd = /** @type {HTMLElement|null} */ (ddEl);
    const anchor = /** @type {HTMLElement|null} */ (anchorEl);
    if (!dd || !anchor) return;

    // Clear last call's inline value before measuring, or the CSS ceiling
    // would read back as whatever we wrote and ratchet down every render.
    dd.style.maxHeight = "";
    const cssCap = parseFloat(window.getComputedStyle(dd).maxHeight);
    const cap = isNaN(cssCap) ? Infinity : cssCap;

    const rect = anchor.getBoundingClientRect();
    const vv = window.visualViewport;
    // getBoundingClientRect is in layout-viewport coordinates; offsetTop is
    // how far the visual box has slid down inside it. Both terms are needed.
    const viewTop = vv ? vv.offsetTop : 0;
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;

    const below = viewBottom - rect.bottom - GAP;
    const above = rect.top - viewTop - GAP;
    const flip = below < MIN && above > below;
    const room = Math.max(MIN, flip ? above : below);

    dd.classList.toggle("is-flipped", flip);
    // Only ever tighten: when there's plenty of room the CSS ceiling stands.
    if (room < cap) dd.style.maxHeight = Math.round(room) + "px";
  }

  /** Undo fit() so the CSS max-height owns the closed state again. */
  function reset(ddEl) {
    const dd = /** @type {HTMLElement|null} */ (ddEl);
    if (!dd) return;
    dd.classList.remove("is-flipped");
    dd.style.maxHeight = "";
  }

  window.BgbDropdownFit = { fit, reset };
})();
