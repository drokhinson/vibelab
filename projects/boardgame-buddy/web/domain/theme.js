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

  function stored() {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch (_) {
      return null;
    }
  }

  function systemMode() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function apply(mode) {
    document.documentElement.setAttribute("data-bgb", mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", META[mode] || META.dark);
    if (window.store) window.store.set("theme", mode);
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

    /** Called once from init.js. */
    start() {
      apply(stored() || systemMode());
      if (!window.matchMedia) return;
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => {
        // An explicit choice outranks the OS; only auto-mode follows along.
        if (stored() === null) apply(systemMode());
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    },
  };

  window.BgbTheme = BgbTheme;
})();
