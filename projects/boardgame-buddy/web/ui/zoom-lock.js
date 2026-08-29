// ui/zoom-lock.js — holds the page at 1x on iOS Safari.
//
// Sibling of ui/viewport-lock.js, deliberately separate: that module MEASURES
// the visible viewport, this one PREVENTS it from changing scale. Opposite
// directions, different failure modes, different accessibility arguments —
// folding this in would make that file's name a lie.
//
// WHY THIS EXISTS
// ---------------
// The app's chrome — .bgb-global-header (position: sticky) and .bgb-nav
// (position: fixed) — is laid out against the LAYOUT viewport, which pinch-zoom
// does not change. So a zoomed page renders both bars at their full unzoomed
// width, scaled up and running off the sides of what the user can actually see.
// Android already behaves: Chrome suppresses pinch in a standalone PWA
// (manifest.json declares display:standalone) and honours user-scalable=no.
// iPhone use is a normal Safari tab, where neither holds.
//
// The viewport meta in index.html carries user-scalable=no, which covers Android
// and iOS *standalone* (home-screen) mode — but iOS Safari 10+ ignores it in a
// normal tab, on purpose, so a site can't trap a user at an unreadable scale.
// These three listeners are what actually locks a Safari tab.
//
// The other two zoom triggers are handled in CSS, not here:
//   - double-tap zoom  → `touch-action: manipulation` on html (styles.css Layout)
//   - focus auto-zoom  → the 16px floor at the END of styles.css. Safari zooms
//                        whenever a focused control computes under 16px, and
//                        neither the meta nor this file suppresses it. That is
//                        the one that fires during ordinary use — every tap into
//                        a round-score cell.
//
// WHAT IS DELIBERATELY NOT BLOCKED
// --------------------------------
// iOS system zoom (Settings → Accessibility → Zoom, three-finger triple tap)
// runs at the OS compositor level, below the web engine — it sees no DOM events
// and nothing here can block it. Same for VoiceOver and Dynamic Type. What this
// does remove is pinch-to-reflow inside the page (WCAG 1.4.4); the 16px floor is
// the mitigation, and it is why that floor is not optional.

(function () {
  let started = false;

  // gesture* are WebKit-only, but desktop Safari also fires them for a trackpad
  // pinch — and blocking browser zoom on a desktop is user-hostile. So gate on
  // "does this device have a touchscreen at all": 0 on desktop Safari, 5 on
  // iPhone/iPad. >0 rather than >1 on purpose — Apple ships no touchscreen Mac,
  // so 0 cleanly separates the two, and emulators that report a single touch
  // point (Chrome device mode, Playwright) still exercise this path instead of
  // silently skipping it.
  const isTouch = (navigator.maxTouchPoints || 0) > 0;

  function block(ev) {
    ev.preventDefault();
  }

  // Idempotent — init.js calls this once on boot and the listeners live for the
  // lifetime of the app.
  function start() {
    if (started || !isTouch) return;
    started = true;
    // Non-passive is the whole point: a passive listener's preventDefault() is
    // ignored. gesture* aren't passive-by-default today; stating it defends
    // against that changing.
    document.addEventListener("gesturestart", block, { passive: false });
    document.addEventListener("gesturechange", block, { passive: false });
    document.addEventListener("gestureend", block, { passive: false });
  }

  // Only those three. A `touchstart` multi-touch guard
  // (`if (ev.touches.length > 1) ev.preventDefault()`) is the obvious-looking
  // addition and is REJECTED on purpose: a stray second finger landing mid-drag
  // in Gather would get preventDefault()'d, WebKit can answer that with
  // `pointercancel`, and widgets/player-reorder.js:226 routes pointercancel
  // straight into cancel() — the drag silently reverts instead of committing.
  // It buys nothing anyway: gesturestart already fires for every two-finger
  // pinch on WebKit, which is the only engine that gets past the gate above.

  window.BgbZoomLock = { start, supported: isTouch };
})();
