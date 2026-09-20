// widgets/cascade-shared.js — what the host's play cascade and the
// spectator's mirror render the same way.
//
// The two views (views/play-flow-view.js, views/session-viewer-view.js) draw
// the same three screens from opposite sides of a session. Most of what they
// share is already a widget (round-score-grid, game-info-bar); this is the
// remainder that was copied instead — the scroll to the current phase and the
// cell lookup the live-scores patch runs on every Realtime echo. (The rulebook
// row was the third of these; migration 052 moved it into the guide itself.)

(function () {
  // RETIRED with migration 052: rulebookRow(url).
  //
  // It drew a Rulebook button above the guide on both cascade screens, from
  // `game.rulebook_url` on the session's own game snapshot — the one
  // admin-curated link a game could have — and drew NOTHING when there was
  // none, which is the state this feature set out to fix.
  //
  // The link is a reference-guide chapter now, and the scroll both screens
  // already mount draws it: in its Rulebook section when open, and in its peek
  // while rolled up, which is how the Play screen opens it. So the button is
  // where it always should have been — beside the rules it belongs with — and
  // a game with no link says so out loud instead of showing an empty strip.

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

  window.BgbCascade = { scrollToPhase, scoreCells };
})();
