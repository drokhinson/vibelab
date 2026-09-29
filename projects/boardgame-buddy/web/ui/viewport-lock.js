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
  // The app's own score pad (widgets/score-keypad.js), which stands in for the
  // system keyboard on a score cell: its height when docked at the bottom, its
  // width when docked on the right. It counts as a keyboard in everything
  // published here, so whatever makes room for one makes room for the pad.
  let padBottom = 0;
  let padRight = 0;

  function sync() {
    if (!vv && !padBottom && !padRight) {
      // No data → the CSS fallback ladder wins, so take back anything the pad set.
      ["--bgb-vv-h", "--bgb-vv-top", "--bgb-kb-inset", "--bgb-pad-right"].forEach((p) => ROOT.style.removeProperty(p));
      ROOT.classList.remove("bgb-kb-open", "bgb-pad-side");
      return;
    }
    // A pinch-zoomed page reports a shrunken visual viewport that has nothing
    // to do with the keyboard. Hold the last good box until the user zooms out
    // rather than sizing a shell from numbers in zoomed CSS pixels. This is a
    // plain early return, not an unsubscribe: zooming back out fires another
    // resize/scroll and the properties refresh themselves.
    //
    // ui/zoom-lock.js now makes this path rare, but not impossible — it is gated
    // on maxTouchPoints, can fail to load offline, and rides on WebKit
    // continuing to honour gesturestart cancellation. So this stays as the last
    // line of defence.
    if (vv && vv.scale && vv.scale > 1.01) return;
    const h = Math.round(vv ? vv.height : window.innerHeight);
    const top = Math.round(vv ? vv.offsetTop || 0 : 0);
    const inset = Math.max(0, Math.round(window.innerHeight - h - top)) + padBottom;
    const pad = padBottom > 0 || padRight > 0;
    ROOT.style.setProperty("--bgb-vv-h", (h - padBottom) + "px");
    ROOT.style.setProperty("--bgb-vv-top", top + "px");
    ROOT.style.setProperty("--bgb-kb-inset", inset + "px");
    ROOT.style.setProperty("--bgb-pad-right", padRight + "px");
    ROOT.classList.toggle("bgb-kb-open", inset > KB_OPEN_PX || pad);
    ROOT.classList.toggle("bgb-pad-side", padRight > 0);
  }

  /**
   * The score pad is up (or down, with 0, 0).
   * @param {number} bottom px it covers along the bottom edge
   * @param {number} right  px it covers along the right edge
   */
  function setPad(bottom, right) {
    const b = Math.max(0, Math.round(bottom || 0));
    const r = Math.max(0, Math.round(right || 0));
    if (b === padBottom && r === padRight) return;
    padBottom = b;
    padRight = r;
    sync();
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
    setPad,
    supported: !!vv,
  };
})();
