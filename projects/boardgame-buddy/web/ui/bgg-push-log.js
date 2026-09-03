// ui/bgg-push-log.js — live readout while a BgB -> BGG push drains.
//
// Sibling of ui/bgg-import-log.js, sharing ui/bgg-log-step.js but not its
// narration: that one walks five import-specific counters (collection_imported,
// plays_pending, unique_games_to_import) with no push analogue, and
// parameterising it would be the options-matrix anti-pattern
// (.claude/rules/ui-object-design.md §2). Two components, one step primitive,
// one CSS family.

(function () {
  /**
   * @typedef {Object} BggPushLogState
   * @property {boolean} pushing   the POST is in flight, or the queue is draining
   * @property {BggPushSummary|null=} summary  null until the POST returns
   * @property {BggPushStatus|null=} status    latest poll, null before the first
   * @property {string|null=} error   a terminal message that replaces the log
   * @property {string=} className    extra class on the root (layout only)
   */

  const MAX_NAMES = 20;
  const step = window.bggLogStep;

  /**
   * Failures by cause, not by game.
   *
   * The push aborts the whole run on a failure every remaining row would hit
   * — a dead session, BGG's bot protection — by stamping the same sentence on
   * every pending row. Printed one per game that read as eighteen separate
   * problems, eighteen screens tall, when it was one problem eighteen times.
   *
   * @param {{game_name:string, message:string}[]|null|undefined} rows
   * @returns {{message:string, names:string[]}[]}
   */
  function groupErrors(rows) {
    const byMessage = new Map();
    for (const row of rows || []) {
      const message = row.message || "It didn't say why.";
      if (!byMessage.has(message)) byMessage.set(message, []);
      byMessage.get(message).push(row.game_name);
    }
    return [...byMessage].map(([message, names]) => ({ message, names }));
  }

  /**
   * The cause on top, the games it hit underneath.
   *
   * Deliberately claims no count of its own: `session_errors` is capped at 20
   * server-side, so "18 games — …" would be a lie the moment a bigger push
   * fails. The heading above already carries the true total, and the shortfall
   * is spelled out once below the list.
   *
   * @param {{message:string, names:string[]}} group
   */
  function renderErrorGroup(group) {
    // One game keeps the original shape — "Hive — <why>" reads better than a
    // cause with a list of one under it.
    if (group.names.length === 1) {
      return `<li><strong>${escapeHtml(group.names[0])}</strong> — ${escapeHtml(group.message)}</li>`;
    }
    return `<li>
      <strong>${escapeHtml(group.message)}</strong>
      <span class="bgg-log__errors-names">${group.names.map(escapeHtml).join(", ")}</span>
    </li>`;
  }

  /**
   * @param {BggPushLogState} state
   * @returns {string} HTML, or "" when there is nothing to say yet.
   */
  function renderBggPushLog(state) {
    const pushing = !!state.pushing;
    const summary = state.summary || null;
    const s = state.status || {};
    const error = state.error || null;
    const cls = `bgg-log${state.className ? ` ${state.className}` : ""}`;

    if (!pushing && error && !summary) {
      return `<div class="${cls}">${escapeHtml(error)}</div>`;
    }
    if (!pushing && !summary) return "";

    const queued = summary ? summary.queued || 0 : 0;
    const done = s.session_done || 0;
    const errored = s.session_errored || 0;
    const total = s.session_total || queued;
    const settled = done + errored;
    const finished = !!summary && (!total || settled >= total);

    const steps = [];

    // The server commits the comparison the user reviewed when it still holds
    // it, and only sweeps BGG again when it does not. Two different things
    // happened, so this says two different things — claiming a re-check that
    // nobody ran is the same species of lie as a full bar over zero writes.
    steps.push(step("done", summary
      ? (summary.reused_comparison
        ? `Used the comparison you just reviewed`
        : `Re-checked your BoardGameGeek collection`)
      : `Re-checking your BoardGameGeek collection`));

    if (summary) {
      const parts = [];
      if (summary.adds) parts.push(`${summary.adds} to add`);
      if (summary.updates) parts.push(`${summary.updates} to change`);
      if (summary.clears) parts.push(`${summary.clears} to clear`);
      steps.push(step("done",
        `Queued ${queued} ${queued === 1 ? "change" : "changes"}` +
        (parts.length ? `<span class="bgg-log__muted"> — ${parts.join(", ")}</span>` : "")));
    } else {
      steps.push(step("active", "Working out what to change"));
    }

    if (queued) {
      // The bar and the count track what LANDED, not what settled. Counting
      // errors as progress is how a push where every single write was refused
      // rendered a full bar reading "18 of 18 sent".
      const pct = total ? Math.round((done / total) * 100) : 0;
      const names = (s.session_game_names || []).slice(0, MAX_NAMES);
      const detail = `
        <div class="bgg-log__bar"><div class="bgg-log__bar-fill" style="width:${pct}%"></div></div>
        <div class="bgg-log__meta"><span>${done} of ${total} sent${
          errored ? ` · ${errored} failed` : ""}</span></div>
        ${names.length ? `<ul class="bgg-log__names">${
          names.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}`;
      let headline;
      if (!finished) {
        headline = `Sending change ${Math.min(settled + 1, total)} of ${total}`;
      } else if (!errored) {
        headline = "Sent every change to BoardGameGeek";
      } else if (done) {
        headline = `Sent ${done} of ${total} ${total === 1 ? "change" : "changes"}`;
      } else {
        headline = "Couldn't send anything to BoardGameGeek";
      }
      steps.push(step(finished && !done ? "error" : (finished ? "done" : "active"),
        headline + detail));
    }

    // A half-failed push has left flags on a third-party account in an unknown
    // state, so the games are named rather than counted.
    let tail = "";
    if (errored) {
      const groups = groupErrors(s.session_errors);
      // The RPC caps session_errors at 20 rows; `errored` is the real count.
      const unlisted = errored - groups.reduce((n, g) => n + g.names.length, 0);
      tail = `<div class="bgg-log__errors">
        <p class="bgg-log__errors-hd">${errored} ${errored === 1 ? "game" : "games"} didn't go through</p>
        <ul>${groups.map(renderErrorGroup).join("")}</ul>
        ${unlisted > 0 ? `<p class="bgg-log__errors-names">…and ${unlisted} more.</p>` : ""}
        <p class="bgg-log__errors-ft">Their BoardGameGeek status may be unchanged. Check status again to see where things stand.</p>
      </div>`;
    } else if (finished && queued) {
      tail = `<p class="bgg-log__ok"><i data-icon="check" class="w-4 h-4"></i>
        BoardGameGeek now matches your BgB shelf.</p>`;
    } else if (finished && !queued) {
      tail = `<p class="bgg-log__ok"><i data-icon="check" class="w-4 h-4"></i>
        Nothing to send — everything already matched.</p>`;
    }

    const err = (!pushing && error)
      ? `<p class="bgg-log__error">${escapeHtml(error)}</p>` : "";

    return `<div class="${cls}"><ol class="bgg-log__steps">${steps.join("")}</ol>${tail}${err}</div>`;
  }

  window.renderBggPushLog = renderBggPushLog;
})();
