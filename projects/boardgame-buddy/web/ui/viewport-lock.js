// ui/viewport-lock.js — publishes the *visible* viewport box as CSS custom
// properties on :root, so any surface can size itself to what the user can
// actually see instead of to the layout viewport.
//
// Why this exists: iOS Safari overlays the software keyboard WITHOUT shrinking
// the layout viewport. `100vh`, `100dvh`, `position: fixed` and
// `position: sticky` all resolve against that layout viewport, so a bottom
// action row sized by any of them still ends up underneath the keyboard.
// window.visualViewport is the only API that reports the box actually on
// screen. `dvh` doesn't cover this either: the dynamic viewport tracks
// retractable browser UI (the URL bar), not interactive widgets — whether the
// keyboard participates is governed by the `interactive-widget` viewport-meta
// key, whose default is `resizes-visual` and which Safari doesn't support.
//
// Same approach as landing/admin.js#syncViewport (the aboutmetrips fix).
//
// Consumers read the properties with a fallback ladder, so a browser without
// visualViewport degrades to plain dvh/vh:
//
//   height: 100vh;                      /* no-dvh fallback   */
//   height: 100dvh;                     /* drops the URL bar */
//   height: var(--bgb-vv-h, 100dvh);    /* drops the keyboard too */

(function () {
  const ROOT = document.documentElement;
  const vv = window.visualViewport || null;
  // Taller than any browser URL bar, shorter than any software keyboard — so
  // .bgb-kb-open means "a keyboard is up", not "the URL bar retracted".
  const KB_OPEN_PX = 120;
  let started = false;

  function sync() {
    if (!vv) return; // no data → the CSS fallback ladder wins
    // A pinch-zoomed page reports a shrunken visual viewport that has nothing
    // to do with the keyboard. Hold the last good box until the user zooms out
    // rather than sizing a shell from numbers in zoomed CSS pixels.
    if (vv.scale && vv.scale > 1.01) return;
    const h = Math.round(vv.height);
    const top = Math.round(vv.offsetTop || 0);
    const inset = Math.max(0, Math.round(window.innerHeight - h - top));
    ROOT.style.setProperty("--bgb-vv-h", h + "px");
    ROOT.style.setProperty("--bgb-vv-top", top + "px");
    ROOT.style.setProperty("--bgb-kb-inset", inset + "px");
    ROOT.classList.toggle("bgb-kb-open", inset > KB_OPEN_PX);
  }

  // Idempotent — init.js calls this once on boot and the listeners live for the
  // lifetime of the app. Two passive listeners is cheaper than making every
  // modal acquire/release a lock, and it means the modal fixes are pure CSS.
  function start() {
    if (started) return;
    started = true;
    if (vv) {
      // `resize` covers the keyboard opening/closing; `scroll` covers the page
      // sliding *within* the visible box, which changes offsetTop without
      // changing height. Both are needed.
      vv.addEventListener("resize", sync);
      vv.addEventListener("scroll", sync);
    }
    window.addEventListener("orientationchange", sync);
    sync();
  }

  window.BgbViewport = {
    start,
    sync,
    supported: !!vv,
  };
})();
