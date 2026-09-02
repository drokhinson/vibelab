// @ts-check
// widgets/bgg-sync-screens.js — the four bodies of the BGG sync flow.
//
// Pure render functions keyed by screen, the same split
// widgets/import-plays-steps.js uses: views/bgg-sync-view.js owns the
// lifecycle, the chrome and the transitions; this file owns nothing but
// markup. Neither knows the other's internals — both read the snapshot
// domain/bgg-sync-flow.js publishes.
//
// Everything about a game's status is rendered by ui/bgg-diff-list.js, and
// everything about a running job by the three ui/bgg-*-log.js components.
// Nothing here re-implements either.

(function () {
  // Per-direction copy. Moved verbatim from the retired
  // widgets/bgg-sync-sheet.js — the sheet is gone, the words were right.
  const COPY = {
    push: {
      title: "Push to BoardGameGeek",
      lede: "This rewrites the collection flags on your real BoardGameGeek account.",
      cta: (n) => `Push ${n} ${n === 1 ? "change" : "changes"}`,
      empty: "Your BoardGameGeek collection already matches your BgB shelf.",
      running: "Pushing to BoardGameGeek",
    },
    pull: {
      title: "Import from BoardGameGeek",
      lede: "This rewrites the shelf statuses in BoardgameBuddy.",
      cta: (n) => `Import ${n} ${n === 1 ? "change" : "changes"}`,
      empty: "Your BgB shelf already matches your BoardGameGeek collection.",
      running: "Importing from BoardGameGeek",
    },
  };

  // The comparison screen is the content, not a slot in a card, so it prints
  // the table rather than the first ten rows of it. The server truncates at
  // 500 and sets `truncated`, which is where "…and N more" comes from — this
  // only stops the CARD variant capping first.
  const SCREEN_MAX_ROWS = 500;

  function plural(n, one, many) { return n === 1 ? one : many; }

  /** Relative time, for "checked just now". Minutes is as fine as this needs. */
  function agoLabel(iso) {
    if (!iso) return "";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 minute ago";
    if (mins < 60) return `${mins} minutes ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs} ${plural(hrs, "hour", "hours")} ago`;
  }

  // ── 1 · Checking ───────────────────────────────────────────────────────────

  function renderChecking(snap) {
    return `
      <div class="bgg-flow__step">
        <h3 class="bgg-flow__title font-display">Comparing your shelves</h3>
        <p class="bgg-flow__lede">
          Nothing is written anywhere while this runs — it only reads.
        </p>
        ${window.renderBggCheckLog(snap.progress, { className: "bgg-log--screen" })}
      </div>
    `;
  }

  // ── 2 · The comparison ─────────────────────────────────────────────────────

  function stat(n, label) {
    return `<div class="bgg-flow__stat">
      <span class="bgg-flow__stat-n">${n}</span>
      <span class="bgg-flow__stat-l">${label}</span>
    </div>`;
  }

  function mark(which) {
    return which === "bgg"
      ? `<span class="bgb-mark bgb-mark--bgg"><img src="assets/credits/bgg-mark.svg" alt="" /></span>`
      : `<span class="bgb-mark bgb-mark--bgb"><img src="assets/brand/bgb-logo.svg" alt="" /></span>`;
  }

  /**
   * The two direction buttons. The marks carry the direction and the caption
   * carries the verb — main's treatment, kept: two SVGs and an arrow tell a
   * screen reader nothing, which is why each still needs a real aria-label.
   */
  function directions(snap) {
    const diff = snap.diff || {};
    const arrow = `<i data-icon="chevron-right" class="w-4 h-4 bgb-mark__arrow"></i>`;
    const face = (marks, cap) =>
      `<span class="bgb-mark__row">${marks}</span><span class="bgb-mark__cap">${cap}</span>`;
    // A partial sweep reads as "not on BGG" downstream, so a push built on one
    // would clear flags off games we simply failed to see. The server refuses
    // it with a 503; saying so here beats spending 40 seconds to be refused.
    const pushBlocked = !!diff.warm_up_retry_pending;
    const pushable = (diff.push_total || 0) > 0;
    const pullable = (diff.pull_total || 0) > 0;
    return `
      <div class="bgg-flow__dirs">
        <button class="btn btn-ghost bgg-flow__dir" type="button"
                ${pullable ? "" : "disabled"}
                aria-label="Import from BoardGameGeek into BoardgameBuddy"
                onclick="window.bggSyncView.choose('pull')">
          ${face(mark("bgg") + arrow + mark("bgb"), "Import to BgB")}
        </button>
        <button class="btn btn-primary bgg-flow__dir" type="button"
                ${pushable && !pushBlocked ? "" : "disabled"}
                aria-label="Push from BoardgameBuddy up to BoardGameGeek"
                onclick="window.bggSyncView.choose('push')">
          ${face(mark("bgb") + arrow + mark("bgg"), "Push to BGG")}
        </button>
      </div>
      ${pushBlocked ? `<p class="bgg-diff__warn">
        Part of your BoardGameGeek collection never finished loading, so this
        comparison is incomplete. Importing is safe; pushing is held back until
        a clean check, because a partial read looks identical to "not on BGG".
      </p>` : ""}
    `;
  }

  /** The catalog fill a check kicked off, while its games are still landing. */
  function catalogLine(snap) {
    const diff = snap.diff || {};
    if (!diff.catalog_pending) return "";
    const s = snap.status || {};
    const drained = window.Bgg.catalogFillDrained(s);
    if (drained) {
      return `<p class="bgg-flow__note">
        <i data-icon="check" class="w-4 h-4"></i>
        Those games have names now.
        <button class="bgg-flow__link" type="button"
                onclick="window.bggSyncView.recheck()">Check again</button>
        to see them.
      </p>`;
    }
    const done = s.catalog_session_done || 0;
    const total = s.catalog_session_total || diff.catalog_pending;
    return `<p class="bgg-flow__note">
      <i data-icon="loader-2" class="w-4 h-4 animate-spin"></i>
      Naming ${done} of ${total} ${plural(total, "game", "games")} new to BgB's catalog…
    </p>`;
  }

  function renderReview(snap) {
    const diff = snap.diff || {};
    const differences = Math.max(diff.push_total || 0, diff.pull_total || 0);

    // The table owns the headline ("8 differences · 31 already in sync") and it
    // counts rows MERGED by bgg_id, which is not max(push_total, pull_total) —
    // a game can appear in both lists. So this screen prints neither number:
    // two counts of the same thing, differing by one, is worse than no count.
    // The two totals below are the ones the table does not show.
    //
    // catalog_pending is zeroed for the same reason: the component's note says
    // "check again in a moment" with nothing to press, and catalogLine() below
    // says the same thing with a live count and a working button.
    const forTable = { ...diff, catalog_pending: 0 };

    return `
      <div class="bgg-flow__step">
        <div class="bgg-flow__head">
          <p class="bgg-flow__lede">Checked ${agoLabel(snap.checkedAt)}.</p>
        </div>
        <div class="bgg-flow__stats">
          ${stat(diff.local_total || 0, "on your shelf")}
          ${stat(diff.remote_total || 0, "on BoardGameGeek")}
        </div>
        ${window.renderBggDiffList(forTable, { variant: "card", max: SCREEN_MAX_ROWS })}
        ${catalogLine(snap)}
        ${differences ? directions(snap) : ""}
      </div>
    `;
  }

  // ── 3 · Confirm one direction ──────────────────────────────────────────────

  function renderConfirm(snap) {
    const dir = snap.direction === "pull" ? "pull" : "push";
    const copy = COPY[dir];
    const diff = snap.diff || {};
    const total = (dir === "pull" ? diff.pull_total : diff.push_total) || 0;
    if (!total) {
      return `<div class="bgg-flow__step">
        <h3 class="bgg-flow__title font-display">${copy.title}</h3>
        <p class="bgg-flow__lede">${copy.empty}</p>
      </div>`;
    }
    return `
      <div class="bgg-flow__step">
        <div class="bgg-flow__head">
          <h3 class="bgg-flow__title font-display">${copy.title}</h3>
          <p class="bgg-flow__lede">${copy.lede}</p>
        </div>
        ${window.renderBggDiffList(diff, { variant: "sheet", direction: dir })}
      </div>
    `;
  }

  /**
   * The commit label, and the count it names.
   *
   * A pull's `held` rows are listed but excluded: they are games kept at
   * Prev. owned that the importer refuses to resurrect, so they are a promise
   * about what will NOT happen, and counting them in "Import 14 changes" would
   * make the button overstate itself. Carried across from the retired sheet.
   */
  function commitLabel(snap) {
    const dir = snap.direction === "pull" ? "pull" : "push";
    const diff = snap.diff || {};
    const rows = (dir === "pull" ? diff.pull_changes : diff.push_changes) || [];
    const total = (dir === "pull" ? diff.pull_total : diff.push_total) || 0;
    const held = dir === "pull" ? rows.filter((r) => r.change === "held").length : 0;
    const actionable = Math.max(0, total - held);
    return { label: COPY[dir].cta(actionable), actionable };
  }

  // ── 4 · The run ────────────────────────────────────────────────────────────

  function renderRunning(snap) {
    const dir = snap.direction === "pull" ? "pull" : "push";
    const copy = COPY[dir];
    const running = snap.screen === "running";

    // A push re-plans server-side before it queues anything — the same sweep
    // as a check. Narrate it rather than showing an empty screen for the 10-40
    // seconds before the first queue count exists.
    const body = (dir === "push" && !snap.summary)
      ? window.renderBggCheckLog(snap.progress, { className: "bgg-log--screen" })
      : dir === "push"
        ? window.renderBggPushLog({
            pushing: running, summary: snap.summary, status: snap.status,
            error: snap.error, className: "bgg-log--screen",
          })
        : window.renderBggImportLog({
            syncing: running, summary: snap.summary, status: snap.status,
            error: snap.error, className: "bgg-log--screen",
          });

    return `
      <div class="bgg-flow__step">
        <div class="bgg-flow__head">
          <h3 class="bgg-flow__title font-display">
            ${snap.screen === "done" ? "Sync complete" : copy.running}
          </h3>
          ${running ? `<p class="bgg-flow__lede">
            You can close this — it keeps running, and Settings will show how far it got.
          </p>` : ""}
        </div>
        ${body}
      </div>
    `;
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  function renderError(snap) {
    return `
      <div class="bgg-flow__step bgg-flow__step--center">
        ${buddyLoader({ size: 96, label: null })}
        <h3 class="bgg-flow__title font-display">That didn't finish</h3>
        <p class="bgg-flow__lede">${escapeHtml(snap.error || "Something went wrong.")}</p>
      </div>
    `;
  }

  window.BggSyncScreens = {
    checking: renderChecking,
    review: renderReview,
    confirm: renderConfirm,
    running: renderRunning,
    done: renderRunning,
    error: renderError,
    // Exposed so the view's footer can label the commit without duplicating
    // the held-row arithmetic.
    commitLabel,
    copy: COPY,
  };
})();
