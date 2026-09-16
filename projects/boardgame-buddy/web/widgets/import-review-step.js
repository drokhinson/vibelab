// widgets/import-review-step.js — the last three screens of every import.
//
// Review, summary, progress: one implementation, whatever the plays came from.
// Before this there were two of each — the notes importer's and the photo
// importer's — and the two `renderImport`s were already ~85% the same file,
// differing in the third summary tile and the wording of two warnings. Two
// copies of a screen is two screens to keep agreeing, and they had begun not
// to: only one of them could edit a table, only one could record a score.
//
// Every source reaches these through the adapter on its draft model
// (`reviewGroups`, `summaryTile`, `reviewNotices`, `progressHeading`, …), so
// nothing here asks which importer it is serving. The two places that genuinely
// differ are both data: a photo row carries a thumbnail and a country, a note
// row carries a count and a run note.
//
// `opts.host` is the global the inline handlers resolve against at click time
// — `"window.importWizardView"` in the wizard, and either of the two importer
// views while they still exist. The host must implement every `_method` named
// below; tools/check-import-wizard.mjs gates that.

(function () {
  /** An inline handler string. Both escape layers are mandatory. */
  function call(host, method, ...args) {
    const list = args.map((a) => `'${jsStr(String(a))}'`).join(", ");
    return escapeAttr(`${host}.${method}(${list})`);
  }

  /** The same, with the element's own value appended as the last argument. */
  function callValue(host, method, ...args) {
    const list = args.map((a) => `'${jsStr(String(a))}'`).join(", ");
    return escapeAttr(`${host}.${method}(${list}${list ? ", " : ""}this.value)`);
  }

  // ── Review ─────────────────────────────────────────────────────────────────

  /**
   * The editable list: every play about to be written, grouped by game.
   *
   * @param {any} model  A draft implementing the review adapter.
   * @param {{host: string, expanded?: Object<string, boolean>,
   *          shownGroups?: number}} opts
   */
  function review(model, opts) {
    const host = opts.host;
    const groups = model.reviewGroups();
    const shown = opts.shownGroups || groups.length;
    const expanded = opts.expanded || {};
    const total = groups.reduce(
      (n, g) => n + g.rows.reduce((m, r) => m + r.count, 0), 0);

    if (!groups.length) {
      return `
        <div class="imp-step imp-step--empty">
          <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <h3 class="imp-step__title font-display">Nothing left to import</h3>
          <p class="imp-step__lede">
            Everything has been dropped. Go back a step, or start over.
          </p>
        </div>
      `;
    }

    const warnings = model.reviewWarnings();
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">${total} play${total === 1 ? "" : "s"}</h3>
        ${warnings.length ? `
          <div class="imp-warnings">
            <div class="imp-warnings__label">Worth checking</div>
            <ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
          </div>
        ` : ""}
        ${model.supportsBulkDate ? `
          <div class="imp-bulkdate">
            <label class="imp-bulkdate__label" for="imp-bulk-date">Date for plays without one</label>
            <input id="imp-bulk-date" class="imp-date" type="date" max="${model.constructor.today}"
                   value="${escapeAttr(model.bulkDate || model.constructor.today)}"
                   onchange="${escapeAttr(`${host}._onBulkDate(this.value)`)}" />
          </div>
        ` : ""}
        <div class="imp-groups">
          ${groups.slice(0, shown).map((g) => renderGroup(g, expanded, host, model)).join("")}
        </div>
        ${shown < groups.length
          ? `<div data-imp-sentinel class="imp-sentinel" aria-hidden="true"></div>`
          : ""}
      </div>
    `;
  }

  function renderGroup(group, expanded, host, model) {
    const plays = group.rows.reduce((n, r) => n + r.count, 0);
    return `
      <section class="imp-group">
        <header class="imp-group__head">
          <span class="imp-group__name">${escapeHtml(group.name)}</span>
          <span class="imp-group__count">${plays}</span>
        </header>
        ${group.rows.map((row) => renderRow(row, expanded, host, model)).join("")}
      </section>
    `;
  }

  /**
   * One review row.
   *
   * Everything indistinguishable is one row carrying all of it — a 58-play run
   * as 58 rows is a list nobody scrolls, and every row would say the same
   * thing. A photo is always exactly one play, so its rows are always rows of
   * one; the collapsing costs it nothing and the two sources read alike.
   */
  function renderRow(row, expanded, host, model) {
    const open = !!expanded[row.id];
    const n = row.count;
    const winners = row.seats.filter((s) => s.is_winner);
    const summary = row.seats.length === 0
      ? "Nobody at the table"
      : (winners.length === 0
        ? "No winner recorded"
        : (winners.length > 1
          ? `Tie — ${winners.map((s) => escapeHtml(s.name)).join(" & ")}`
          : `${escapeHtml(winners[0].name)} won`));
    return `
      <div class="imp-play${open ? " is-open" : ""}${row.seats.length ? "" : " imp-play--seatless"}">
        <button class="imp-play__head" type="button" aria-expanded="${open}"
                onclick="${call(host, "_toggleRow", row.id)}">
          <span class="imp-play__chev"><i data-icon="${open ? "chevron-down" : "chevron-right"}" class="w-4 h-4"></i></span>
          ${row.thumbUrl
            ? `<img class="imp-play__thumb" src="${escapeAttr(row.thumbUrl)}" alt="" />`
            : ""}
          <span class="imp-play__body">
            <span class="imp-play__title">
              ${n > 1 ? `${n} identical plays` : formatDate(row.playedAt)}
            </span>
            <span class="imp-play__sub">
              ${summary}${n > 1 ? ` · ${formatDate(row.playedAt)}` : ""}
            </span>
          </span>
          <span class="imp-play__drop" role="button" tabindex="0"
                aria-label="Remove ${n > 1 ? `these ${n} plays` : "this play"}"
                onclick="event.stopPropagation();${call(host, "_dropRow", row.id)}">
            <i data-icon="trash-2" class="w-4 h-4"></i>
          </span>
        </button>
        ${open ? renderRowDetail(row, host, model) : ""}
      </div>
    `;
  }

  function renderRowDetail(row, host, model) {
    return `
      <div class="imp-play__detail">
        ${row.seats.length
          ? renderSeats(row, host)
          : `<p class="imp-warn">
               Nobody is at this table, so it can't be imported — a play needs at
               least one player. Add somebody below, or drop it.
             </p>`}
        <button class="imp-seat imp-seat--add" type="button"
                onclick="${call(host, "_openRowPlayerSheet", row.id)}">
          <span class="imp-seat__addmark"><i data-icon="user-plus" class="w-3.5 h-3.5"></i></span>
          <span class="imp-seat__name">Add players</span>
        </button>
        ${row.edited ? `
          <p class="imp-note">
            You've edited this table, so it no longer follows the Players step.
          </p>
        ` : ""}
        ${row.notes ? `<p class="imp-play__notes">${escapeHtml(row.notes)}</p>` : ""}
        ${row.countryCode ? `
          <p class="imp-play__notes">
            Played in ${escapeHtml(window.Geo ? window.Geo.countryName(row.countryCode) : row.countryCode)}
          </p>
        ` : ""}
        <div class="imp-play__fields">
          <label class="imp-field">
            <span class="imp-field__label">Date</span>
            <input class="imp-date" type="date" max="${model.constructor.today}"
                   value="${escapeAttr(row.playedAt)}"
                   onchange="${callValue(host, "_onRowDate", row.id)}" />
          </label>
          <button class="imp-field imp-field--btn" type="button"
                  onclick="${call(host, "_openRowGameSheet", row.id)}">
            <span class="imp-field__label">Game</span>
            <span class="imp-field__value">${escapeHtml(row.game ? row.game.name : "Not matched")}</span>
          </button>
        </div>
        ${row.countEditable ? `
          <label class="imp-field imp-field--count">
            <span class="imp-field__label">How many plays</span>
            <input class="imp-count-input" type="number" min="1" max="300" step="1"
                   value="${row.count}"
                   aria-label="Number of plays in this row"
                   onchange="${callValue(host, "_onRowCount", row.id)}" />
          </label>
          <p class="imp-note">
            Editing anything else here changes all ${row.count} —
            ${row.runNote ? escapeHtml(row.runNote) : "they came out identical."}
            If that's wrong, correct the number above.
          </p>
        ` : ""}
      </div>
    `;
  }

  /**
   * The table, editable.
   *
   * A seat is addressed by WHO it is (`whoOf`), never by the name on it: an
   * account and a ghost can carry one display name — which is exactly what the
   * models' seat collapse exists to keep apart — and a name-keyed handler hits
   * both.
   *
   * The score is DISABLED on a row standing for more than one play. Fifty-eight
   * plays that all scored 112 is not a thing that happened, and every edit here
   * applies to the whole row, so offering the field would be offering to write
   * a fiction.
   */
  function renderSeats(row, host) {
    const multi = row.count > 1;
    const whoOf = window.PlayImport.whoOf;
    return `
      <ul class="imp-seats">
        ${row.seats.map((seat) => {
          const who = whoOf(seat);
          return `
          <li class="imp-seat${seat.is_winner ? " is-winner" : ""}">
            ${window.BgbBadge.render({
              displayName: seat.name,
              size: "xs",
              isGhost: !seat.user_id,
              extraClass: "imp-seat__badge",
            })}
            <span class="imp-seat__name">${escapeHtml(seat.name)}</span>
            <input class="imp-seat__score-input" type="number" step="1" inputmode="numeric"
                   value="${seat.score == null ? "" : seat.score}"
                   placeholder="—" ${multi ? "disabled" : ""}
                   aria-label="${escapeAttr(`Score for ${seat.name}`)}"
                   onchange="${callValue(host, "_onSeatScore", row.id, who)}" />
            <button class="imp-seat__win" type="button"
                    aria-pressed="${seat.is_winner ? "true" : "false"}"
                    aria-label="${escapeAttr(seat.is_winner
                      ? `${seat.name} won` : `Mark ${seat.name} the winner`)}"
                    onclick="${call(host, "_toggleRowWinner", row.id, who)}">
              <i data-icon="trophy" class="w-3.5 h-3.5"></i>
            </button>
            <button class="imp-seat__x" type="button"
                    aria-label="${escapeAttr(`Remove ${seat.name} from this table`)}"
                    onclick="${call(host, "_removeRowSeat", row.id, who)}">
              <i data-icon="x" class="w-3.5 h-3.5"></i>
            </button>
          </li>
        `;
        }).join("")}
      </ul>
      <p class="imp-note">
        Tap the trophy to mark a winner — several is a tie. × takes somebody off
        this table.${multi
          ? " Scores differ play to play, so set the count to 1 below to record one."
          : ""}
      </p>
    `;
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  /**
   * What is about to be written, and the button that writes it.
   *
   * The by-game breakdown counts THE PLAYS THAT WILL LAND, not the review
   * list's groups: a group is every live play of one game, seatless ones
   * included, so reading the breakdown off it would print a per-game tally
   * that doesn't add up to the number above it.
   *
   * @param {any} model
   * @param {{host: string, importing?: boolean}} opts
   */
  function summary(model, opts) {
    const host = opts.host;
    const busy = !!opts.importing;
    const p = model.progress;
    if (p && (busy || p.done >= p.total)) return progress(model, busy, opts);

    const ready = model.importable();
    const byGame = new Map();
    for (const item of ready) {
      const game = model.sourceKey === "notes" ? model.playGame(item) : item.game;
      const row = byGame.get(game.id);
      if (row) { row.plays++; continue; }
      byGame.set(game.id, { name: game.name, plays: 1 });
    }
    const tile = model.summaryTile();
    const notices = model.reviewNotices();
    const note = model.ctaNote();

    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Ready to import</h3>
        <dl class="imp-summary">
          <div><dt>Plays</dt><dd>${ready.length}</dd></div>
          <div><dt>Games</dt><dd>${byGame.size}</dd></div>
          <div>
            <dt>${escapeHtml(tile.label)}</dt><dd>${escapeHtml(String(tile.value))}</dd>
            ${tile.note ? `<div class="imp-summary__note">${escapeHtml(tile.note)}</div>` : ""}
          </div>
        </dl>
        <ul class="imp-bygame">
          ${Array.from(byGame.values()).map((g) => `
            <li><span>${escapeHtml(g.name)}</span><span>${g.plays}</span></li>
          `).join("")}
        </ul>
        ${notices.map((n) => `<p class="imp-warn">${escapeHtml(n.text)}</p>`).join("")}
        <button class="imp-cta" type="button" ${ready.length ? "" : "disabled"}
                onclick="${escapeAttr(`${host}._startImport()`)}">
          Import ${ready.length} play${ready.length === 1 ? "" : "s"}
        </button>
        ${note ? `<p class="imp-note">${escapeHtml(note)}</p>` : ""}
      </div>
    `;
  }

  // ── Progress ───────────────────────────────────────────────────────────────

  /** @param {any} model @param {boolean} busy @param {{host: string}} opts */
  function progress(model, busy, opts) {
    const host = opts.host;
    const p = model.progress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
    const failed = p.failed > 0;
    const note = model.progressNote(p);
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">${escapeHtml(model.progressHeading(p, busy))}</h3>
        <div class="imp-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="${pct}" aria-label="Import progress">
          <div class="imp-progress__fill" style="width:${pct}%"></div>
        </div>
        <p class="imp-progress__label">${p.done} of ${p.total}</p>
        ${busy ? "" : `
          <dl class="imp-summary">
            <div><dt>Added</dt><dd>${p.imported}</dd></div>
            ${p.duplicate ? `<div><dt>Already there</dt><dd>${p.duplicate}</dd></div>` : ""}
            ${failed ? `<div><dt>Failed</dt><dd>${p.failed}</dd></div>` : ""}
          </dl>
          ${note ? `<p class="imp-note">${escapeHtml(note)}</p>` : ""}
          ${failed ? `
            <p class="imp-warn">
              ${p.failed} play${p.failed === 1 ? "" : "s"} didn't land. Everything else did —
              running the import again picks up only what's missing.
            </p>
            <button class="imp-cta imp-cta--ghost" type="button"
                    onclick="${escapeAttr(`${host}._startImport()`)}">Try the rest again</button>
          ` : ""}
          <button class="imp-cta" type="button"
                  onclick="${escapeAttr(`${host}._finish()`)}">
            ${failed ? "Done" : "See your plays"}
          </button>
        `}
      </div>
    `;
  }

  window.ImportReviewStep = { review, summary, progress };
})();
