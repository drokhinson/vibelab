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

    steps.push(step("done", summary
      ? `Re-checked your BoardGameGeek collection`
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
      const pct = total ? Math.round((settled / total) * 100) : 0;
      const names = (s.session_game_names || []).slice(0, MAX_NAMES);
      const detail = `
        <div class="bgg-log__bar"><div class="bgg-log__bar-fill" style="width:${pct}%"></div></div>
        <div class="bgg-log__meta"><span>${settled} of ${total} sent</span></div>
        ${names.length ? `<ul class="bgg-log__names">${
          names.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}`;
      steps.push(step(finished ? "done" : "active",
        (finished
          ? `Sent every change to BoardGameGeek`
          : `Sending change ${Math.min(settled + 1, total)} of ${total}`) + detail));
    }

    // A half-failed push has left flags on a third-party account in an unknown
    // state, so the games are named rather than counted.
    let tail = "";
    if (errored) {
      const rows = (s.session_errors || []).slice(0, MAX_NAMES);
      tail = `<div class="bgg-log__errors">
        <p class="bgg-log__errors-hd">${errored} ${errored === 1 ? "game" : "games"} didn't go through</p>
        <ul>${rows.map((e) =>
          `<li><strong>${escapeHtml(e.game_name)}</strong> — ${escapeHtml(e.message)}</li>`).join("")}</ul>
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
