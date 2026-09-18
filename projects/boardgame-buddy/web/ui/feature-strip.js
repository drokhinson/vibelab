// @ts-check
// ui/feature-strip.js — the five features, condensed to one line each.
//
// The sign-in screen's whole sell, and the one thing a stranger who has not
// made an account can read. The lines come from widgets/tour-chapters.js, so
// the strip and the tour cannot disagree about what the app does.
//
// WHY THE MARKS ARE PAINTED THROUGH A CSS MASK
// --------------------------------------------
// .claude/rules/assets.md ranks `fill="currentColor"` first, because a mark
// that inherits the ink of whatever surface it lands on needs no per-theme
// rule at all. But an SVG loaded through <img> cannot see currentColor OR the
// page's custom properties — it is a separate document. So the file goes in as
// a MASK and the ink is a background: the alpha channel comes from the sprite,
// the colour from the surface, and the mark is correct in both themes with one
// CSS rule and no second artwork file.
//
// The per-row url() is set as a custom property rather than as a literal
// `background-image`, which is the data-derived exception in
// .claude/rules/theming.md §10 — never a literal colour.

(function () {
  const BASE = "assets/sprites/features/bgb-feat-";

  /**
   * @param {{heading?: string, cta?: boolean, ctaLabel?: string}} [opts]
   *   heading  overrides the strip's own head line; "" drops it
   *   cta      render the "See how it works" button (default true)
   * @returns {string} HTML
   */
  function render(opts) {
    const o = opts || {};
    const heading = o.heading === undefined ? "What you get" : o.heading;
    const showCta = o.cta !== false;
    const rows = window.TourChapters.all().map((ch, i) => `
      <li class="feat-strip__row" style="--i:${i}; --feat-mark:url('${BASE}${ch.mark}.svg')">
        <span class="feat-strip__mark" aria-hidden="true"></span>
        <span class="feat-strip__txt">${ch.strip}</span>
      </li>`).join("");

    return `
      <div class="feat-strip">
        ${heading ? `<p class="feat-strip__head">${heading}</p>` : ""}
        <ul class="feat-strip__list">${rows}</ul>
        ${showCta ? `
          <button type="button" class="feat-strip__cta"
                  onclick="window.router.go('tour')">
            <span>${o.ctaLabel || "See how it works"}</span>
            <i data-icon="arrow-right" class="w-4 h-4"></i>
          </button>` : ""}
      </div>`;
  }

  window.BgbFeatureStrip = { render };
})();
