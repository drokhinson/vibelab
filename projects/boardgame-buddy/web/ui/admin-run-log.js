// @ts-check
// ui/admin-run-log.js — what an admin catalog run is doing, and what it did.
//
// Two halves, and they answer different questions:
//
//   • THE CHECKLIST (ui/phase-log.js, shared with the BGG comparison) says
//     WHICH STEP. It is a fixed sequence, it restarts on every pass of a
//     drain, and it is how you see where a run is stuck.
//   • THE JOURNAL (here, and nowhere else) says WHICH ITEM. A checklist
//     cannot tell you that Gloomhaven failed with a 502 while the other
//     nineteen in its batch landed, and that is the thing an operator opens
//     this page for. It does NOT reset between passes, so a twenty-five-pass
//     drain reads as one log with pass breaks in it.
//
// Pure function of GET /admin/runs/{tool}. No fetching, no timers — the flow
// owns the poll.

(function () {
  /** Newest lines go at the BOTTOM, like a terminal: a run is read forwards,
   *  and a live run's newest line should appear where the eye already is. */
  function renderJournal(progress) {
    const events = (progress && progress.events) || [];
    const dropped = (progress && progress.events_dropped) || 0;
    if (!events.length && !dropped) return "";

    let lastPass = -1;
    const rows = events.map((e) => {
      // A pass break rather than a pass column: on a single-pass run there is
      // nothing to say, and on a long drain one line every few hundred rows is
      // enough to orient by.
      const brk = e.pass_no > 0 && e.pass_no !== lastPass
        ? `<li class="admin-run__pass">Pass ${e.pass_no + 1}</li>`
        : "";
      lastPass = e.pass_no;
      const level = e.level === "error" || e.level === "warn" ? e.level : "info";
      return `${brk}<li class="admin-run__line admin-run__line--${level}">
        <span class="admin-run__at">${escapeHtml(clockTime(e.at))}</span>
        <span class="admin-run__msg">${escapeHtml(e.message)}</span>
      </li>`;
    }).join("");

    // Said out loud rather than quietly starting mid-run — a log that silently
    // begins at "Batch 340" reads as a bug in the log.
    const trimmed = dropped
      ? `<li class="admin-run__pass">${dropped} earlier ${dropped === 1 ? "line" : "lines"} not kept</li>`
      : "";

    return `<section class="admin-run__journal">
      <h3 class="admin-run__journal-head">Log</h3>
      <ol class="admin-run__lines">${trimmed}${rows}</ol>
    </section>`;
  }

  /** hh:mm:ss, local. Seconds matter: the gaps between lines are the throttle,
   *  and "is it moving?" is most of what this page is asked. */
  function clockTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour12: false });
  }

  /** The one-line score, above the log. */
  function renderTotals(progress) {
    const t = (progress && progress.totals) || null;
    if (!t) return "";
    const parts = [`${t.updated} updated`];
    if (t.failed) parts.push(`${t.failed} failed`);
    if (t.remaining) parts.push(`${t.remaining} still to do`);
    return `<p class="admin-run__totals">${escapeHtml(parts.join(" · "))}</p>`;
  }

  /**
   * @typedef {Object} AdminRunLogOpts
   * @property {Object<string,string>} labels  phase key → the sentence on screen
   * @property {string[]=} order      fallback order for a payload predating a phase
   * @property {boolean=} stale       the ledger stopped being written (see the flow)
   * @property {string=} className
   */

  /**
   * @param {any} progress  GET /admin/runs/{tool}, or null before the first poll
   * @param {AdminRunLogOpts} opts
   * @returns {string}
   */
  function renderAdminRunLog(progress, opts) {
    const o = opts || {};
    const state = (progress && progress.state) || "unknown";

    const failed = state === "failed" && progress.error
      ? `<p class="bgg-log__errors">${escapeHtml(progress.error)}</p>`
      : "";
    // A run whose ledger stopped being written is NOT a run in progress, and
    // saying "running" about it is the lie this notice exists to avoid. The
    // flow decides staleness; this only reports it.
    const stalled = o.stale
      ? `<p class="bgg-log__errors">This run stopped reporting. It was most likely
          interrupted — nothing is half-written, and continuing picks up where it
          left off.</p>`
      : "";

    const checklist = window.renderPhaseLog(progress, {
      labels: o.labels,
      order: o.order,
      notices: `${stalled}${failed}`,
      className: o.className,
      // No pendingRow: unlike the BGG check, a run here is started from this
      // very page, so "no record" means none has run — the view paints its own
      // idle state and never reaches this renderer.
    });

    return `${checklist}${renderTotals(progress)}${renderJournal(progress)}`;
  }

  window.renderAdminRunLog = renderAdminRunLog;
})();
