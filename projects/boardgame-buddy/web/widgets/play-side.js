// widgets/play-side.js — the Play step's right-hand column on the wide and land
// tiers: the standings stacked above the reference guide, beside the grid.
//
// The column folds to a 48px strip on the right edge, which hands the scoring
// grid the whole width. That choice is a per-viewer convenience, so it lives in
// localStorage (and a browser that refuses storage simply opens unfolded).
//
// The class that folds it, `.is-side-min`, sits on `.play-pager`. The host view
// writes it into every render from its own flag, and toggle() flips the live
// element too, so a fold never waits on a repaint. The bar is drawn on every
// tier; styles.css shows it only where the column exists.
//
// Shared by views/play-flow-view.js and views/session-viewer-view.js.

// @ts-check

(function () {
  const KEY = "bgb.playSideMin";

  function load() {
    try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; }
  }

  /**
   * @param {HTMLElement|null} root   the view's container
   * @param {boolean} current
   * @returns {boolean} the new state
   */
  function toggle(root, current) {
    const next = !current;
    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch (_) {}
    const pager = root && root.querySelector("#screen-play .play-pager");
    if (pager) pager.classList.toggle("is-side-min", next);
    return next;
  }

  /** @param {string} host  the view's window global, e.g. "playFlowView" */
  function renderBar(host) {
    return `
      <div class="play-side-bar">
        <button type="button" class="play-side-bar__btn play-side-bar__fold"
                aria-label="Hide standings and guide"
                onclick="window.${host}._togglePlaySide()">
          <i data-icon="chevron-right" class="w-4 h-4"></i>
        </button>
        <button type="button" class="play-side-bar__btn play-side-bar__unfold"
                aria-label="Show standings and guide"
                onclick="window.${host}._togglePlaySide()">
          <i data-icon="chevron-left" class="w-4 h-4"></i>
        </button>
      </div>`;
  }

  window.BgbPlaySide = { load, toggle, renderBar };
})();
