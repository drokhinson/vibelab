// widgets/cascade-shared.js — what the host's play cascade and the
// spectator's mirror render the same way.
//
// The two views (views/play-flow-view.js, views/session-viewer-view.js) draw
// the same three screens from opposite sides of a session. Most of what they
// share is already a widget (round-score-grid, game-info-bar); this is the
// remainder that was copied instead — the rulebook row, the scroll to the
// current phase, and the cell lookup the live-scores patch runs on every
// Realtime echo.

(function () {
  /** The Rulebook button under the game strip. No rulebook → no row at all. */
  function rulebookRow(url) {
    if (!url) return "";
    return `
      <div class="cascade-rulebook-row">
        <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
           class="btn btn-outline btn-sm cascade-rulebook-cta">
          <i data-icon="book-open" class="w-4 h-4"></i>
          <span>Rulebook</span>
          <i data-icon="external-link" class="w-3.5 h-3.5"></i>
        </a>
      </div>
    `;
  }

  /**
   * Scroll the cascade to the screen for `phase`, one frame later so a fresh
   * innerHTML has been laid out first.
   * @param {string|null|undefined} phase
   * @param {ScrollIntoViewOptions} [opts]
   */
  function scrollToPhase(phase, opts) {
    let id = "screen-gather";
    if (phase === "play") id = "screen-play";
    else if (phase === "settle" || phase === "finalized") id = "screen-settle";
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView(Object.assign({ block: "start" }, opts));
    });
  }

  /**
   * Every score cell in `container`, keyed "i-r" (column index, round). One
   * pass over the grid rather than one document scan per cell — a six-player,
   * ten-round grid patched on every keystroke echo was sixty scans.
   * @param {ParentNode} container
   * @returns {Map<string, HTMLElement>}
   */
  function scoreCells(container) {
    const map = new Map();
    for (const el of container.querySelectorAll("[data-score-cell]")) {
      map.set(el.getAttribute("data-score-cell"), /** @type {HTMLElement} */ (el));
    }
    return map;
  }

  window.BgbCascade = { rulebookRow, scrollToPhase, scoreCells };
})();
