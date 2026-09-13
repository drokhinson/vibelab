// ui/game-stats-panel.js — one viewer's record with one game.
//
// The canonical renderer for the "how has this game actually gone for me"
// object (.claude/rules/ui-object-design.md §2). Two surfaces draw it:
//
//   * the Stats spoke's By game card, from bgb_user_stats_detail's games[];
//   * Game Detail's Your record section, from the detail bundle's
//     viewer_stats block (migration 030).
//
// Both rows are computed by the same rules, in SQL, so the ring on the game's
// own page and the ring one tap deeper into the profile cannot disagree — which
// is the whole reason this is a function rather than a second block of markup.
//
// It renders the numbers and nothing around them: no card, no heading, no game
// name. The surface owns its own frame, because the two are different kinds of
// frame (a paper preview-card there, a section of the game page here) and the
// panel has no business knowing which one it landed in.
//
// Paper/chrome tokens only (--polaroid-*, --accent-ink): it is drawn on a light
// card in both themes on the spoke, so a caller putting it on the app ground
// re-points those tokens rather than the panel reaching for ground ones
// (.claude/rules/theming.md §6 — .game-detail__statspanel is that re-point).

(function () {
  // 2πr for the dial, so the dasharray never drifts from the r in the markup.
  const RING_R = 44;

  /**
   * @typedef {Object} GameStatsRow
   * @property {number} plays            every play of the game the viewer
   *                                     logged or sat in
   * @property {number} wins             plays the viewer's own seat won
   * @property {number} [decided_plays]  the subset that recorded a result —
   *                                     the denominator `wins` is read against.
   *                                     Absent on a pre-020 cached payload, in
   *                                     which case `plays` stands in.
   * @property {number} [scored_plays]   plays where the winner carried a score
   * @property {?number} avg_winning_score
   * @property {?number} your_avg_score
   * @property {?number} your_best_score
   * @property {string} [play_mode]      'coop' reads as the table vs. the game
   * @property {?string} [last_played_at]
   */

  /**
   * @param {GameStatsRow} g
   * @returns {string} ring + facts + split bar + footnote, as HTML.
   */
  function renderGameStatsPanel(g) {
    // Wins are read against the plays that recorded a RESULT, never against
    // every play: a play nobody won and nobody scored said nothing about how
    // it went, and counting it here reports a loss that never happened. The
    // fallback keeps a cached pre-018 payload rendering the old way rather
    // than dividing by undefined.
    const decided = g.decided_plays != null ? g.decided_plays : g.plays;
    const pct = decided ? Math.round((g.wins / decided) * 100) : 0;
    const undecided = Math.max(0, (g.plays || 0) - decided);
    const circ = 2 * Math.PI * RING_R;
    const offset = circ * (1 - pct / 100);
    const isCoop = g.play_mode === "coop";
    // A co-op game has no per-player score to average, and a competitive one
    // may simply never have had scores typed in. Both land on the same
    // dashes; the footnote is what tells them apart.
    const noScores = g.avg_winning_score == null;
    const scoreCell = (v) => (noScores
      ? `<span class="stats-fact__v stats-fact__v--none">no scores</span>`
      : `<span class="stats-fact__v">${v}</span>`);

    return `
      <div class="stats-ratio">
        <div class="stats-ring">
          <svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
            <circle class="stats-ring__track" cx="52" cy="52" r="${RING_R}" fill="none" stroke-width="11" />
            <circle class="stats-ring__arc" cx="52" cy="52" r="${RING_R}" fill="none" stroke-width="11"
                    stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}"
                    stroke-dashoffset="${offset.toFixed(1)}" />
          </svg>
          <div class="stats-ring__mid">
            <div>
              <div class="stats-ring__pct">${decided ? `${pct}%` : "&mdash;"}</div>
              <div class="stats-ring__lab">${isCoop ? "Table wins" : "Win rate"}</div>
            </div>
          </div>
        </div>
        <div class="stats-facts">
          <div class="stats-fact"><span class="stats-fact__k">Plays</span><span class="stats-fact__v">${g.plays}</span></div>
          <div class="stats-fact"><span class="stats-fact__k">Wins</span><span class="stats-fact__v stats-fact__v--gold">${g.wins}</span></div>
          <div class="stats-fact"><span class="stats-fact__k">Avg winning score</span>${scoreCell(g.avg_winning_score)}</div>
          <div class="stats-fact"><span class="stats-fact__k">Your average</span>${scoreCell(g.your_avg_score)}</div>
          <div class="stats-fact"><span class="stats-fact__k">Your best</span>${scoreCell(g.your_best_score)}</div>
        </div>
      </div>

      ${decided ? `
        <div class="stats-split">
          <i class="stats-split__win" style="width:${pct}%"></i>
          <i class="stats-split__loss" style="width:${100 - pct}%"></i>
        </div>
        <div class="stats-legend">
          <span>${isCoop ? "Beat the game" : "Won"} <b>${g.wins}</b></span>
          <span>${isCoop ? "Lost to it" : "Lost"} <b>${decided - g.wins}</b></span>
        </div>
      ` : ""}

      <p class="stats-foot">${footnote(g, isCoop, noScores, decided, undecided)}</p>
    `;
  }

  function footnote(g, isCoop, noScores, decided, undecided) {
    const last = g.last_played_at ? ` Last played ${formatDate(g.last_played_at)}.` : "";
    // The Plays fact counts every play; the ring counts only the ones the
    // viewer sat in AND that recorded a result (migration 020's `decided`).
    // Both halves of the gap have to be named, or the sentence libels a play
    // that has a winner and simply wasn't one of theirs.
    const blanks = undecided
      ? ` ${undecided} of ${g.plays} ${g.plays === 1 ? "play" : "plays"} ${undecided === 1 ? "is" : "are"} left out of the win rate — no result recorded, or logged without you at the table.`
      : "";
    if (!decided) {
      return escapeHtml(
        (g.plays === 1
          ? "This play recorded no winner and no score, so there's no win rate to show yet."
          : `None of these ${g.plays} plays recorded a winner or a score, so there's no win rate to show yet.`)
        + last,
      );
    }
    if (isCoop) {
      return escapeHtml(
        `Co-operative game — a win here is the whole table beating the game, and no per-player score is kept.${blanks}${last}`,
      );
    }
    if (noScores) {
      return escapeHtml(`No scores were logged on any of these plays, so there's no average to show.${blanks}${last}`);
    }
    return escapeHtml(
      `Winning score averaged across the ${g.scored_plays} of ${g.plays} ` +
      `${g.plays === 1 ? "play" : "plays"} that recorded scores.${blanks}${last}`,
    );
  }

  window.renderGameStatsPanel = renderGameStatsPanel;
})();
