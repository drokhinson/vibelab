// ui/stat-primitives.js — the labelled horizontal bar, shared by both stats screens.
//
// Extracted at instance #2 (`.claude/rules/ui-object-design.md` §4), not the
// fourth: the Profile hub's Stats spoke has drawn these for table sizes and
// per-game plays since it shipped, and the admin Usage spoke needs the same
// mark for its screen leaderboard and its per-table Postgres sizes.
//
// It owns APPEARANCE ONLY — one function, one string, no state and no DOM
// work, so it composes inside any view's template literal. The `.stat-bar`
// CSS family travels with it.
//
// Paper/chrome tokens only (`--polaroid-*`, `--accent-fill-grad`). The Stats
// spoke lands on a polaroid and the Usage spoke on `bgb-spoke-screen`, and
// both re-point that family — so a caller reaching for a ground token
// (`oklch(var(--b1))`) would invert on one of the two. See
// `.claude/rules/theming.md` §6.

(function () {
  const BgbStat = {
    /**
     * One row: a label, a proportional bar, and a right-aligned figure.
     *
     * @param {string} label
     * @param {number} value  drives the bar width
     * @param {number} peak   the value that fills the track
     * @param {Object} [opts]
     * @param {string} [opts.display]  what to print instead of `value` — a
     *   byte count reads "412 MB" where a play count reads "37". The BAR still
     *   follows `value`, so the two can never disagree about length.
     * @param {string} [opts.sub]      a second line under the label.
     * @param {boolean} [opts.wide]    widen the label and figure columns.
     *   The default grid was tuned for the Stats spoke — short labels
     *   ("4 players") and bare integers. A screen name, a table name or a
     *   formatted byte count needs more: measured at 420px, "Notes or photos
     *   import" wants 124px against the default column's 83, and "164 kB"
     *   wraps to two lines in a 2rem figure column. Reach for this whenever a
     *   label is prose or a figure carries a unit.
     * @param {string} [opts.cls]      extra class on the row.
     * @returns {string} HTML
     */
    bar(label, value, peak, opts) {
      const o = opts || {};
      const cls = [o.wide ? "stat-bar--wide" : "", o.cls || ""].filter(Boolean).join(" ");
      // A floor of 4%, so a real-but-tiny value is still a visible mark rather
      // than an empty track that reads as zero. Guarded against peak <= 0,
      // which is every bar on a screen where nothing has happened yet —
      // without it the width is NaN and the fill vanishes entirely.
      const w = peak > 0 ? Math.max(4, Math.round((value / peak) * 100)) : 4;
      const shown = o.display != null ? o.display : String(value);
      // The label's markup is built on ONE line on purpose. `.stat-bar__k` is
      // nowrap with an ellipsis, and HTML collapses the indentation of a
      // pretty-printed template into a real leading space — which shifts every
      // label a few pixels right and can tip one that previously just fitted
      // into being truncated. Do not re-indent this.
      const k = `${escapeHtml(label)}${o.sub ? `<em>${escapeHtml(o.sub)}</em>` : ""}`;
      return `
        <div class="stat-bar${cls ? " " + cls : ""}">
          <span class="stat-bar__k" title="${escapeAttr(label)}">${k}</span>
          <span class="stat-bar__track"><i style="width:${w}%"></i></span>
          <span class="stat-bar__v">${escapeHtml(shown)}</span>
        </div>
      `;
    },
  };

  window.BgbStat = BgbStat;
})();
