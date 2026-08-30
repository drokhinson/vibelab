// theme.js — light / dark theme state for {{PROJECT_TITLE}}.
//
// The initial attribute is set by an inline script in index.html so it lands
// before first paint (see the "Theme boot" block there); this module owns every
// change after that. Two sources of truth, in order: an explicit stored choice,
// otherwise the OS preference — and while the user has made no explicit choice
// we keep following the OS live.
//
// The attribute is `data-{{PROJECT_ID}}` on <html>, deliberately separate from
// DaisyUI's `data-theme`. styles.css overrides --b1/--b2/--b3/--bc under it,
// which is what re-themes every rule that paints with oklch(var(--b*)).
//
// See .claude/rules/theming.md.

(function () {
  const ATTR = "data-{{PROJECT_ID}}";
  const LS_KEY = "{{PROJECT_ID}}.theme";
  // Keep in step with --bg-0 in each theme block of styles.css.
  const META = { light: "#F4F3F8", dark: "#14131A" };

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
    const m = mql || window.matchMedia("(prefers-color-scheme: light)");
    return m.matches ? "light" : "dark";
  }

  /** The mode we should be painting right now: explicit choice, else the OS. */
  function resolved() {
    return stored() || systemMode();
  }

  function apply(mode) {
    document.documentElement.setAttribute(ATTR, mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", META[mode] || META.dark);
  }

  /** Re-derive and repaint. Cheap and idempotent — safe on every foreground event. */
  function resync() {
    const want = resolved();
    if (want !== Theme.current()) apply(want);
  }

  const Theme = {
    /** @returns {"light"|"dark"} the mode currently painted */
    current() {
      return document.documentElement.getAttribute(ATTR) === "light" ? "light" : "dark";
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

    /** Drop the explicit choice and go back to following the OS ("Auto"). */
    clear() {
      try {
        localStorage.removeItem(LS_KEY);
      } catch (_) {}
      apply(systemMode());
    },

    toggle() {
      Theme.set(Theme.current() === "light" ? "dark" : "light");
    },

    resync,

    /** Called once on DOMContentLoaded. */
    start() {
      apply(resolved());

      // Foreground resync. On iOS the `change` listener below is not enough on
      // its own: changing appearance means leaving the app, so the page is
      // hidden — frozen, or in the back/forward cache — and WebKit does not
      // reliably deliver a media-query change to a page in that state. The same
      // is true of the automatic sunrise/sunset switch. Re-deriving whenever we
      // come back to the foreground covers both without depending on the event.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) resync();
      });
      window.addEventListener("pageshow", resync);   // bfcache restore
      window.addEventListener("focus", resync);      // standalone PWA

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

  window.Theme = Theme;
})();
