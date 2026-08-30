// domain/theme.js — light / dark theme state.
//
// The initial attribute is set by an inline script in index.html so it lands
// before first paint (see the "Theme boot" block there); this module owns every
// change after that. Two sources of truth, in order: an explicit stored choice,
// otherwise the OS preference — and while the user has made no explicit choice
// we keep following the OS live.
//
// The attribute is `data-bgb` on <html>, deliberately separate from DaisyUI's
// `data-theme`. styles.css overrides --b1/--b2/--b3/--bc under it, which is what
// re-themes every rule that paints with oklch(var(--b*)).

(function () {
  const LS_KEY = "bgb.theme";
  const META = { light: "#F7F0E1", dark: "#1A1310" };

  // Module-scoped on purpose — see start(). A MediaQueryList held only by a
  // function local can be garbage-collected in WebKit while its `change`
  // listener is still registered, and the listener then silently stops firing.
  let mql = null;

  function stored() {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch (_) {
      return null;
    }
  }

  function systemMode() {
    if (!window.matchMedia) return "dark";
    // Reuse the retained list once start() has made one, so the reads that
    // resync() does can't be answered by a stale throwaway object.
    const m = mql || window.matchMedia("(prefers-color-scheme: light)");
    return m.matches ? "light" : "dark";
  }

  /** The mode we should be painting right now: explicit choice, else the OS. */
  function resolved() {
    return stored() || systemMode();
  }

  function apply(mode) {
    document.documentElement.setAttribute("data-bgb", mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", META[mode] || META.dark);
    if (window.store) window.store.set("theme", mode);
  }

  // Re-derive and repaint. Cheap and idempotent, so it is safe to call on every
  // foreground event.
  function resync() {
    const want = resolved();
    if (want !== BgbTheme.current()) apply(want);
  }

  const BgbTheme = {
    /** @returns {"light"|"dark"} the mode currently painted */
    current() {
      return document.documentElement.getAttribute("data-bgb") === "light" ? "light" : "dark";
    },

    /** @returns {boolean} true when following the OS rather than an explicit pick */
    isAuto() {
      return stored() === null;
    },

    /** @param {"light"|"dark"} mode */
    set(mode) {
      if (mode !== "light" && mode !== "dark") return;
      try {
        localStorage.setItem(LS_KEY, mode);
      } catch (_) {}
      apply(mode);
    },

    /** Drop the explicit choice and go back to following the OS. */
    clear() {
      try {
        localStorage.removeItem(LS_KEY);
      } catch (_) {}
      apply(systemMode());
    },

    toggle() {
      BgbTheme.set(BgbTheme.current() === "light" ? "dark" : "light");
    },

    /** Exposed for the foreground listeners below; also useful from the console. */
    resync,

    /** Called once from init.js. */
    start() {
      apply(resolved());

      // Foreground resync. On iOS the `change` event below is not enough on its
      // own, for two reasons that both bite exactly the reported case (Auto
      // mode, appearance flipped in Settings/Control Center):
      //
      //   1. Changing appearance means leaving the app, so the page is hidden —
      //      and frozen, or in the back/forward cache. WebKit does not reliably
      //      deliver a media-query change to a page in that state, so on return
      //      matchMedia().matches is already correct but no listener ever ran.
      //   2. The same happens for the automatic sunrise/sunset switch, which
      //      lands while the app is backgrounded far more often than not.
      //
      // Re-deriving whenever we come back to the foreground covers both without
      // depending on the event at all. `pageshow` catches the bfcache restore,
      // `visibilitychange` the ordinary app switch, `focus` the standalone-PWA
      // cases where neither of those fires.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) resync();
      });
      window.addEventListener("pageshow", resync);
      window.addEventListener("focus", resync);

      if (!window.matchMedia) return;
      mql = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => {
        // An explicit choice outranks the OS; only auto-mode follows along.
        if (stored() === null) apply(systemMode());
      };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange);
    },
  };

  window.BgbTheme = BgbTheme;
})();
