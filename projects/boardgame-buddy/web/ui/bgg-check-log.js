// @ts-check
// ui/bgg-check-log.js — the checklist a BGG comparison ticks through.
//
// Third sibling of ui/bgg-import-log.js and ui/bgg-push-log.js, sharing
// ui/bgg-log-step.js and nothing else. Same argument as the push log
// (.claude/rules/ui-object-design.md §2): the two existing logs narrate the
// draining of a QUEUE — n of m games, by name — and this narrates a fixed
// sequence of PHASES with no per-item counters at all. Parameterising either
// into covering both would be the options matrix that rule exists to prevent.
//
// Pure function of GET /bgg/check/progress. No fetching, no timers: the flow
// owns the poll and re-renders its host on each tick.
//
// TWO THINGS THE SERVER TELLS US THAT MATTER HERE:
//   • state "unknown" is NOT done. Progress lives in an in-process cache, so a
//     server restart — or a poll landing on a worker that never ran this check
//     — erases the ledger while the request itself is still perfectly alive.
//     Rendering that as a finished checklist would be a lie; rendering it as
//     an error would be a worse one. It gets one honest active row.
//   • a step's `retry` is a warm-up backoff in flight. BGG answers a large
//     collection request with a "still preparing" placeholder, and the client
//     sleeps 5, then 10, then 20 seconds. That is the single most common
//     reason a check feels hung, so it is the one thing this log says loudest.

(function () {
  const step = window.bggLogStep;

  // What each phase is called on screen. Keyed by the server's BggCheckPhase.
  // Not derived from the enum: these are sentences the user reads, and the
  // wire names are for the wire.
  const LABEL = {
    guards: "Checking your BoardGameGeek link",
    collection: "Reading your BoardGameGeek collection",
    shelf: "Reading your BoardgameBuddy shelf",
    compare: "Comparing the two",
    catalog: "Looking up games BgB has never seen",
    collids: "Matching your BGG entries",
    queue: "Importing new games so they can be named",
  };

  // Order is the server's, which is the order the phases run. The response
  // carries them already sorted; this is only the fallback for a payload that
  // predates a phase.
  const ORDER = ["guards", "collection", "shelf", "compare", "catalog", "collids", "queue"];

  /**
   * "3 of 8" — only when the phase actually counts something. The sweep does
   * (eight subtype × flag requests); "comparing the two" does not.
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
   * The warm-up line. `resume_at` is an absolute epoch second from the server,
   * so the countdown is against the moment the request actually resumes rather
   * than however long after the fact this poll happened to land.
   * @param {any} retry
   */
  function retryLine(retry) {
    if (!retry) return "";
    const left = Math.max(0, Math.round((retry.resume_at * 1000 - Date.now()) / 1000));
    const when = left > 0 ? `retrying in ${left}s` : "retrying now";
    return `<span class="bgg-log__retry">
      BoardGameGeek is still preparing your collection — ${when}
      <span class="bgg-log__muted">(attempt ${retry.attempt} of ${retry.of})</span>
    </span>`;
  }

  /**
   * @param {any} s  one BggCheckStep
   * @returns {string}
   */
  function renderStep(s) {
    const label = LABEL[s.key] || s.key;
    // A skipped phase reads as done-and-greyed rather than as a state of its
    // own: it is a thing that did not need doing, and the primitive's three
    // states are shared with two other logs that have no such case.
    const state = s.state === "skipped" ? "done"
      : s.state === "active" ? "active"
      : s.state === "done" ? "done"
      : "idle";
    const muted = s.state === "skipped" ? " bgg-log__body--skipped" : "";
    const detail = s.detail
      ? `<span class="bgg-log__muted">${escapeHtml(s.detail)}</span>`
      : "";
    return step(state, `
      <span class="bgg-check__row${muted}">
        <span class="bgg-check__label">${escapeHtml(label)}</span>
        ${counter(s)}
      </span>
      ${detail}
      ${bar(s)}
      ${retryLine(s.retry)}
    `);
  }

  /**
   * @typedef {Object} BggCheckLogOpts
   * @property {boolean=} pending   the POST is away but no ledger has come back
   * @property {string=} className  extra class on the root (layout only)
   */

  /**
   * @param {any} progress  GET /bgg/check/progress, or null before the first poll
   * @param {BggCheckLogOpts=} opts
   * @returns {string}
   */
  function renderBggCheckLog(progress, opts) {
    const o = opts || {};
    const cls = `bgg-log${o.className ? ` ${o.className}` : ""}`;
    const state = progress && progress.state ? progress.state : "unknown";
    const steps = (progress && progress.steps) || [];

    // No ledger: either the first poll has not answered yet, or the server has
    // no record of this check. Both mean the same thing to the user — it is
    // running, we just cannot say which part. One honest row beats seven
    // guesses.
    if (!steps.length || state === "unknown") {
      return `<div class="${cls}">
        <ol class="bgg-log__steps">
          ${step("active", `
            <span class="bgg-check__row">
              <span class="bgg-check__label">Reading your BoardGameGeek collection</span>
            </span>
            <span class="bgg-log__muted">This usually takes about 30 seconds.</span>
          `)}
        </ol>
      </div>`;
    }

    const byKey = {};
    for (const s of steps) byKey[s.key] = s;
    const ordered = steps.length === ORDER.length
      ? steps
      : ORDER.map((k) => byKey[k]).filter(Boolean);

    const failed = state === "failed" && progress.error
      ? `<p class="bgg-log__errors">${escapeHtml(progress.error)}</p>`
      : "";
    // Surfaced here as well as on the comparison screen, because this is where
    // the user watched it happen: a batch that gave up returned zero items, so
    // the sweep is partial and the push will refuse to run on it.
    const warm = progress.warm_up_failed
      ? `<p class="bgg-log__errors">BoardGameGeek never finished preparing part of your
          collection, so this comparison is incomplete. Importing is still safe;
          pushing is not, and will be offered again after a clean check.</p>`
      : "";

    return `<div class="${cls}">
      <ol class="bgg-log__steps">${ordered.map(renderStep).join("")}</ol>
      ${warm}${failed}
    </div>`;
  }

  window.renderBggCheckLog = renderBggCheckLog;
})();
