// domain/layout.js — phone / tablet / wide layout tier.
//
// The same shape as domain/theme.js, for the same reasons. The initial
// attribute is set by an inline script in index.html so it lands before first
// paint (the "Layout boot" block there); this module owns every change after
// that. Two sources of truth, in order: an explicit stored choice, otherwise
// the viewport width — and while the user has made no explicit choice we keep
// following the viewport live (a rotation, a resized window).
//
// The attribute is `data-bgb-layout` on <html>. styles.css re-declares the
// column and rail tokens under it (the "Layout tiers" block at the top), which
// is what widens #app, moves every docked bar with it, and on wide swaps the
// bottom nav for a left rail. Views that lay out differently per tier read
// `store("layout")` — set here on every change — through View#listen.
//
// Tiers:
//   phone   < 768px    today's layout, untouched
//   tablet  768–1023   720px column, bottom bar stays
//   wide    ≥ 1024     left rail, header folded into it, 1040px column
//
// A stored choice is `phone` or `tablet`, never `wide`: pinning a tier is for
// a device that lands on the wrong side of a breakpoint, and the rail is not
// something a 700px screen can hold. And a stored `tablet` still floors to
// `phone` below MIN_TABLET_PX — a two-pane play cascade on a real phone is
// two panes nobody can read.

(function () {
  const LS_KEY = "bgb.layout";
  const BREAKPOINTS = { tablet: 768, wide: 1024 };
  const MIN_TABLET_PX = 600;

  // Module-scoped on purpose — see start(). A MediaQueryList held only by a
  // function local can be garbage-collected in WebKit while its `change`
  // listener is still registered, and the listener then silently stops firing.
  let mqlTablet = null;
  let mqlWide = null;

  function stored() {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v === "phone" || v === "tablet" ? v : null;
    } catch (_) {
      return null;
    }
  }

  function matches(query) {
    if (!window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }

  /** The tier the viewport alone asks for, ignoring any stored choice. */
  function auto() {
    // Reuse the retained lists once start() has made them, so the reads that
    // resync() does can't be answered by a stale throwaway object.
    const wide = mqlWide ? mqlWide.matches : matches("(min-width: " + BREAKPOINTS.wide + "px)");
    if (wide) return "wide";
    const tablet = mqlTablet ? mqlTablet.matches : matches("(min-width: " + BREAKPOINTS.tablet + "px)");
    return tablet ? "tablet" : "phone";
  }

  /** The tier we should be laying out right now: explicit choice, else auto. */
  function resolved() {
    const pick = stored();
    if (pick === null) return auto();
    if (pick === "tablet" && matches("(max-width: " + (MIN_TABLET_PX - 1) + "px)")) return "phone";
    return pick;
  }

  function apply(tier) {
    document.documentElement.setAttribute("data-bgb-layout", tier);
    if (window.store) window.store.set("layout", tier);
  }

  // Re-derive and re-lay-out. Cheap and idempotent, so it is safe to call on
  // every resize and foreground event.
  function resync() {
    const want = resolved();
    if (want !== BgbLayout.current()) apply(want);
  }

  const BgbLayout = {
    BREAKPOINTS,

    /** @returns {"phone"|"tablet"|"wide"} the tier currently laid out */
    current() {
      const v = document.documentElement.getAttribute("data-bgb-layout");
      return v === "tablet" || v === "wide" ? v : "phone";
    },

    /** The viewport's own answer, ignoring any stored choice. Use this for
     *  "is this a phone-sized device" questions (the install prompt), where a
     *  desktop user who pinned the phone layout must not count as a phone. */
    auto,

    /** @returns {"phone"|"tablet"|null} the pinned tier, or null on Auto */
    stored,

    /** @returns {boolean} true when following the viewport rather than a pin */
    isAuto() {
      return stored() === null;
    },

    /** @param {"phone"|"tablet"} tier */
    set(tier) {
      if (tier !== "phone" && tier !== "tablet") return;
      try {
        localStorage.setItem(LS_KEY, tier);
      } catch (_) {}
      apply(resolved());
    },

    /** Drop the pin and go back to following the viewport. */
    clear() {
      try {
        localStorage.removeItem(LS_KEY);
      } catch (_) {}
      apply(auto());
    },

    /** Exposed for the listeners below; also useful from the console. */
    resync,

    /** Called once from init.js. */
    start() {
      apply(resolved());

      // Foreground resync, for the same reason theme.js has one: a rotation
      // or a window resize that lands while the page is hidden or in the
      // bfcache is not reliably delivered as a media-query change on iOS.
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) resync();
      });
      window.addEventListener("pageshow", resync);
      window.addEventListener("focus", resync);
      window.addEventListener("orientationchange", resync);

      if (!window.matchMedia) return;
      mqlTablet = window.matchMedia("(min-width: " + BREAKPOINTS.tablet + "px)");
      mqlWide = window.matchMedia("(min-width: " + BREAKPOINTS.wide + "px)");
      // Not gated on isAuto(): a pinned tablet still floors to phone under
      // MIN_TABLET_PX, so a resize can change the answer either way.
      for (const m of [mqlTablet, mqlWide]) {
        if (m.addEventListener) m.addEventListener("change", resync);
        else if (m.addListener) m.addListener(resync);
      }
    },
  };

  window.BgbLayout = BgbLayout;
})();
