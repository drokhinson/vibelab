// @ts-check
// ui/phase-log.js — a checklist of PHASES, ticking through in order.
//
// Extracted from ui/bgg-check-log.js when the admin run page needed the same
// thing (.claude/rules/ui-object-design.md §4: extract at instance #2, and
// split along lifecycle versus appearance). What lives here is the part that
// is identical and fiddly — the state mapping, the counter, the bar, the
// ordering fallback and the no-ledger-yet case. What does NOT live here is any
// sentence a user reads: labels, notices and per-step extras all come in
// through opts, because those are what make the two logs different screens.
//
// This is the FIXED-SEQUENCE family. Its siblings ui/bgg-import-log.js and
// ui/bgg-push-log.js narrate the draining of a QUEUE — n of m games, by name —
// and share only ui/bgg-log-step.js with it. Parameterising a queue log and a
// phase log into one function would be the options matrix that rule exists to
// prevent; see bgg-check-log.js's header for the original argument.
//
// Pure function of a progress snapshot. No fetching, no timers: the caller
// owns the poll and re-renders its host on each tick.

(function () {
  const step = window.bggLogStep;

  /**
   * "3 of 8" — only when the phase actually counts something. A sweep of eight
   * subtype × flag requests does; "comparing the two" does not.
   * @param {any} s
   */
  function counter(s) {
    if (typeof s.total !== "number" || !s.total) return "";
    const done = typeof s.done === "number" ? s.done : 0;
    return `<span class="bgg-log__meta">${done} of ${s.total}</span>`;
  }

  /**
   * The progress bar, for a counting phase that is currently running.
   * @param {any} s
   */
  function bar(s) {
    if (s.state !== "active" || typeof s.total !== "number" || !s.total) return "";
    const done = typeof s.done === "number" ? s.done : 0;
    const pct = Math.max(0, Math.min(100, Math.round((done / s.total) * 100)));
    return `<div class="bgg-log__bar"><div class="bgg-log__bar-fill" style="width:${pct}%"></div></div>`;
  }

  /**
   * @param {any} s        one step of the snapshot
   * @param {PhaseLogOpts} o
   * @returns {string}
   */
  function renderStep(s, o) {
    const label = (o.labels && o.labels[s.key]) || s.key;
    // A skipped phase reads as done-and-greyed rather than as a state of its
    // own: it is a thing that did not need doing, and the primitive's states
    // are shared with two other logs that have no such case.
    const state = s.state === "skipped" ? "done"
      : s.state === "active" ? "active"
        : s.state === "done" ? "done"
          : "idle";
    const muted = s.state === "skipped" ? " bgg-log__body--skipped" : "";
    const detail = s.detail
      ? `<span class="bgg-log__muted">${escapeHtml(s.detail)}</span>`
      : "";
    const extra = o.renderExtra ? o.renderExtra(s) : "";
    return step(state, `
      <span class="bgg-check__row${muted}">
        <span class="bgg-check__label">${escapeHtml(label)}</span>
        ${counter(s)}
      </span>
      ${detail}
      ${bar(s)}
      ${extra}
    `);
  }

  /**
   * @typedef {Object} PhaseLogOpts
   * @property {Object<string,string>=} labels  phase key → the sentence on screen
   * @property {string[]=} order       fallback order for a payload predating a phase
   * @property {(s:any)=>string=} renderExtra   per-step trailer (a retry countdown)
   * @property {string=} notices       HTML appended under the list (warnings, errors)
   * @property {string=} pendingRow    what to draw when there is no ledger at all
   * @property {string=} className     extra class on the root (layout only)
   */

  /**
   * @param {any} progress   the snapshot, or null before the first poll
   * @param {PhaseLogOpts=} opts
   * @returns {string}
   */
  function renderPhaseLog(progress, opts) {
    const o = opts || {};
    const cls = `bgg-log${o.className ? ` ${o.className}` : ""}`;
    const state = progress && progress.state ? progress.state : "unknown";
    const steps = (progress && progress.steps) || [];

    // No ledger. What that MEANS differs per caller — for the BGG check it is
    // "running, we just cannot say which part"; for an admin run it is
    // "nothing has run recently" — so the caller supplies the row, and a
    // caller that handles the case itself passes none and gets nothing.
    if (!steps.length || state === "unknown") {
      if (!o.pendingRow) return "";
      return `<div class="${cls}"><ol class="bgg-log__steps">${o.pendingRow}</ol></div>`;
    }

    const order = o.order || [];
    const byKey = {};
    for (const s of steps) byKey[s.key] = s;
    // The server sends them already sorted; the fallback only matters for a
    // payload that predates a phase.
    const ordered = !order.length || steps.length === order.length
      ? steps
      : order.map((k) => byKey[k]).filter(Boolean);

    return `<div class="${cls}">
      <ol class="bgg-log__steps">${ordered.map((s) => renderStep(s, o)).join("")}</ol>
      ${o.notices || ""}
    </div>`;
  }

  window.renderPhaseLog = renderPhaseLog;
})();
