// domain/layout.js — phone / tablet / wide layout tier.
//
// The initial attribute is set by an inline script in index.html so it lands
// before first paint (the "Layout boot" block there); this module owns every
// change after that. One source of truth: the viewport, followed live — a
// rotation, a resized window, a foreground after either.
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
//   land    sideways   a phone on its side: the same rail, compact
//
// `land` is the one tier that is not a width. A phone held sideways is 852×393,
// which every width test here calls a tablet — so it keeps a 53px header and a
// 64px bottom bar on a 393px screen, a third of the short axis spent on chrome.
// Width cannot tell an iPad standing up (768×1024) from a phone lying down;
// height can, which is why LAND_QUERY leads with it and is asked first.
//
// There is no pin. Settings used to offer Auto / Phone / Tablet, which stored
// `bgb.layout` and let that outrank the viewport; the card is gone and so is
// every reader of that key. Nothing removes it on the way past on purpose —
// once nothing reads it, a leftover value is inert, and anyone who had pinned a
// tier is released by the next load rather than by a migration that would then
// have to live here forever. Do not reintroduce a reader without also
// reintroducing the control that clears it: a stored override with no UI to
// undo it strands whoever set it.

(function () {
  const BREAKPOINTS = { tablet: 768, wide: 1024 };

  // A phone on its side. Three clauses, each ruling something out:
  //   orientation  — portrait is never this tier, whatever its size.
  //   max-height   — the one test that separates it from an iPad (≥ 744px on
  //                  its side). 560px clears every phone in landscape, which
  //                  run 375–430px tall, with room to spare.
  //   min-width    — below this there is no room for two panes beside a rail,
  //                  so a very narrow device stays on the bottom bar.
  // Read against the LAYOUT viewport, which iOS does not shrink for the
  // software keyboard — so focusing a field cannot flip the tier.
  const LAND_QUERY =
    "(orientation: landscape) and (max-height: 560px) and (min-width: 640px)";

  // Module-scoped on purpose — see start(). A MediaQueryList held only by a
  // function local can be garbage-collected in WebKit while its `change`
  // listener is still registered, and the listener then silently stops firing.
  let mqlTablet = null;
  let mqlWide = null;
  let mqlLand = null;

  function matches(query) {
    if (!window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }

  /** The tier the viewport asks for. */
  function auto() {
    // Reuse the retained lists once start() has made them, so the reads that
    // resync() does can't be answered by a stale throwaway object.
    // Asked first, and deliberately: a landscape phone satisfies the tablet
    // width test too, so a width-first ladder would never reach this.
    const land = mqlLand ? mqlLand.matches : matches(LAND_QUERY);
    if (land) return "land";
    const wide = mqlWide ? mqlWide.matches : matches("(min-width: " + BREAKPOINTS.wide + "px)");
    if (wide) return "wide";
    const tablet = mqlTablet ? mqlTablet.matches : matches("(min-width: " + BREAKPOINTS.tablet + "px)");
    return tablet ? "tablet" : "phone";
  }

  function apply(tier) {
    document.documentElement.setAttribute("data-bgb-layout", tier);
    if (window.store) window.store.set("layout", tier);
  }

  // Re-derive and re-lay-out. Cheap and idempotent, so it is safe to call on
  // every resize and foreground event.
  function resync() {
    const want = auto();
    if (want !== BgbLayout.current()) apply(want);
  }

  const BgbLayout = {
    BREAKPOINTS,
    /** The media query that defines the `land` tier. Exported so a consumer
     *  can watch the same string rather than keep a copy of it in step. */
    LAND_QUERY,

    /** @returns {"phone"|"tablet"|"wide"|"land"} the tier currently laid out */
    current() {
      const v = document.documentElement.getAttribute("data-bgb-layout");
      // Every consumer reads the tier through here, so a value missing from
      // this list does not throw — it quietly reports "phone" and the JS half
      // of a tier stops happening while the CSS half still paints.
      return v === "tablet" || v === "wide" || v === "land" ? v : "phone";
    },

    /** The viewport's answer, read live off the media queries rather than off
     *  the attribute `current()` reports. The two agree except in the window
     *  between a resize and its resync, which is why the install prompt asks
     *  this one. */
    auto,

    /** Exposed for the listeners below; also useful from the console. */
    resync,

    /** Called once from init.js. */
    start() {
      apply(auto());

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
      mqlLand = window.matchMedia(LAND_QUERY);
      for (const m of [mqlTablet, mqlWide, mqlLand]) {
        if (m.addEventListener) m.addEventListener("change", resync);
        else if (m.addListener) m.addListener(resync);
      }
    },
  };

  window.BgbLayout = BgbLayout;
})();
