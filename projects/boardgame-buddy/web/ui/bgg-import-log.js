// @ts-check
// ui/bgg-import-log.js — the live readout of a BoardGameGeek import.
//
// The one renderer for the "what is my BGG sync doing right now" step log,
// hosted by widgets/bgg-sync-screens.js.
//
// It reads a sync's two payloads and nothing else: the POST /bgg/sync summary
// (what landed immediately, how much was queued) and the GET /bgg/sync/status
// poll (how far the background worker has drained that queue). It is a pure
// function of those — no fetching, no timers, no DOM. The caller owns the
// poll and re-renders the host on each tick.
//
// THE LAST STEP COUNTS PLAYS IT DID NOT IMPORT. The sync stopped writing plays
// when the importer grew a BoardGameGeek source; it reads them to say how many
// are missing, and the done screen's CTA hands that number to the wizard. So
// step 5 narrates a FINDING rather than an outcome, and it has three faces —
// a count, "already up to date", and a read that failed. That last one is the
// one worth keeping: `plays_new = 0` because BoardGameGeek would not answer
// looks exactly like `plays_new = 0` because there is nothing new, and telling
// somebody with four hundred plays waiting that they are up to date is worse
// than telling them to try again.
//
// Why a shared component rather than a second copy: the log is the visual
// representation of one domain thing — a BGG import — and it already reads
// five interacting fields across two payloads to decide which of its five
// steps is idle, active or done. A parallel implementation would drift on the
// first counter that changes meaning. See .claude/rules/ui-object-design.md §2.

(function () {
  /**
   * @typedef {Object} BggSyncSummary  POST /bgg/sync
   * @property {number} collection_imported
   * @property {number} collection_pending
   * @property {number} plays_new    BGG plays with no row in BgB yet.
   * @property {number} plays_total  Every play on the BGG account.
   * @property {boolean=} plays_read_failed  The /plays read never landed.
   * @property {number} unique_games_to_import
   * @property {boolean=} warm_up_retry_pending
   */

  /**
   * @typedef {Object} BggSyncStatus  GET /bgg/sync/status
   * @property {number=} session_total
   * @property {number=} session_done
   * @property {number=} session_errored
   * @property {string[]=} session_game_names
   */

  /**
   * @typedef {Object} BggImportLogState
   * @property {boolean} syncing   the POST is in flight, or the queue is draining
   * @property {BggSyncSummary|null=} summary  null until the POST returns
   * @property {BggSyncStatus|null=} status    latest poll, null before the first
   * @property {string|null=} error   a terminal message that replaces the log
   * @property {string=} className    extra class on the root (layout only)
   */

  // Names stream in newest-first and the list is capped server-side at 20;
  // showing all of them keeps the log a readable paragraph rather than a
  // scrolling wall on an account with hundreds of missing games.
  const MAX_NAMES = 20;

  // Shared with ui/bgg-push-log.js — see ui/bgg-log-step.js.
  const step = window.bggLogStep;

  /**
   * @param {BggImportLogState} state
   * @returns {string} HTML, or "" when there is nothing to say yet.
   */
  function renderBggImportLog(state) {
    const syncing = !!state.syncing;
    const summary = state.summary || null;
    const b = state.status || {};
    const error = state.error || null;
    const cls = `bgg-log${state.className ? ` ${state.className}` : ""}`;

    // A warm-up or transport failure short-circuits the whole log — there are
    // no counters to narrate, only the reason nothing happened.
    if (!syncing && error && !summary) {
      return `<div class="${cls}">${escapeHtml(error)}</div>`;
    }
    if (!syncing && !summary) return "";

    const total = b.session_total || 0;
    const done = b.session_done || 0;
    const errored = b.session_errored || 0;
    // True once polling shows every queued game has resolved (or there was
    // nothing to queue in the first place).
    const importsResolved = !summary
      ? false
      : (summary.unique_games_to_import || 0) === 0
        || (total > 0 && (done + errored) >= total);
    const finished = !syncing && importsResolved;

    const collectionImmediate = summary ? (summary.collection_imported || 0) : 0;
    const missingCount = summary ? (summary.unique_games_to_import || 0) : 0;
    const newGames = summary
      ? collectionImmediate + (summary.collection_pending || 0)
      : 0;
    // Found, not imported — see the header.
    const playsNew = summary ? (summary.plays_new || 0) : 0;
    const playsUnread = !!(summary && summary.plays_read_failed);

    // Step 1 — request is in flight or already returned a summary.
    const step1 = step(summary || finished ? "done" : "active",
      "Importing data from BoardGameGeek");

    // Step 2 — immediate writes (games already in our catalog). Collection
    // only: this sync writes no plays.
    const step2 = summary
      ? step("done",
          `<strong>${collectionImmediate}</strong> game${collectionImmediate === 1 ? "" : "s"} imported`)
      : "";

    // Step 3 — missing games that the worker has to fetch from BGG.
    // Bullet list streams in via session_game_names as each title lands.
    let step3 = "";
    if (summary && missingCount > 0) {
      const names = (b.session_game_names || []).slice(0, MAX_NAMES);
      const remaining = Math.max(0, missingCount - names.length - errored);
      const bullets = names.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
      const pendingTail = remaining > 0 && !finished
        ? `<li class="bgg-log__sublist-pending">…${remaining} more queued</li>`
        : "";
      const erroredTail = errored > 0
        ? `<li class="bgg-log__sublist-error">${errored} couldn't be imported</li>`
        : "";
      const sublist = (bullets || pendingTail || erroredTail)
        ? `<ul class="bgg-log__sublist">${bullets}${pendingTail}${erroredTail}</ul>`
        : "";
      step3 = step(
        importsResolved ? "done" : "active",
        `<strong>${missingCount}</strong> missing in Boardgame Buddy${sublist}`
      );
    }

    // Steps 4 + 5 only appear once the worker has drained the queue. They
    // restate the final totals so the user can scan the whole sync outcome at
    // a glance.
    const step4 = finished
      ? step("done", `<strong>${newGames}</strong> new game${newGames === 1 ? "" : "s"} added to collection`)
      : "";
    // Step 5 is the hand-off, not an outcome — three faces, see the header.
    let step5 = "";
    if (finished && playsUnread) {
      // "error" rather than "done": a step that finished and achieved nothing
      // is not a done step — the state ui/bgg-log-step.js added for exactly
      // this, so it does not draw a checkmark beside a check that never ran.
      step5 = step("error", "Couldn't check your plays this time — try again shortly");
    } else if (finished && playsNew) {
      step5 = step("done",
        `<strong>${playsNew}</strong> play${playsNew === 1 ? "" : "s"} on BoardGameGeek `
        + `${playsNew === 1 ? "isn't" : "aren't"} here yet`);
    } else if (finished) {
      step5 = step("done", "Your plays are already up to date");
    }

    const footer = finished
      ? `<div class="bgg-log__footer">Sync complete</div>`
      : "";

    return `
      <div class="${cls}">
        <ol class="bgg-log__steps">
          ${step1}
          ${step2}
          ${step3}
          ${step4}
          ${step5}
        </ol>
        ${footer}
      </div>
    `;
  }

  window.renderBggImportLog = renderBggImportLog;
})();
