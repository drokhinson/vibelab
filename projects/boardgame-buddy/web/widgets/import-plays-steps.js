// @ts-check
// widgets/import-plays-steps.js — the play importer's six step bodies.
//
// Pure functions of the draft (domain/play-import.js). Every one returns an
// HTML string and touches nothing; the view owns state, sheets and events.
// Same shell/bodies split as onboarding-deck.js / onboarding-deck-slides.js,
// along the seam that matters: what a step IS versus how the wizard moves
// between them.
//
// Handlers are inline `onclick="window.importPlaysView._foo()"` strings — the
// project idiom, and what keeps these functions pure. Anything carrying a name
// the user typed goes through jsStr THEN escapeAttr; see helpers.js for why
// both layers are needed.

(function () {
  const V = "window.importPlaysView";
  /** A handler attribute for a call with one user-typed string argument. */
  const call = (method, arg) => escapeAttr(`${V}.${method}('${jsStr(arg)}')`);

  // ── Step 1: Source ─────────────────────────────────────────────────────────

  function renderSource(draft) {
    const used = draft.text.length;
    const max = window.PlayImport.maxChars;
    const over = used > max;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Paste your notes</h3>
        <p class="imp-step__lede">
          A list, a table, a page of tally marks — whatever you already keep.
          It gets read into plays you'll review before anything is saved.
        </p>
        <textarea id="imp-source" class="imp-textarea" rows="12"
                  placeholder="Carcassonne&#10;Sean - |||| |||| ||||&#10;Mick - |||| |||| |||&#10;Biggest win: Mick 644, Sean 429"
                  aria-label="Your notes"
                  oninput="${V}._onSourceInput(this.value)">${escapeHtml(draft.text)}</textarea>
        <div class="imp-step__foot-row">
          <label class="imp-filebtn">
            <input type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv"
                   onchange="${V}._onFilePick(event)" />
            <i data-icon="upload" class="w-4 h-4"></i>
            <span>Choose a file</span>
          </label>
          <span class="imp-count${over ? " is-over" : ""}">
            ${used.toLocaleString()} / ${max.toLocaleString()}
          </span>
        </div>
        ${over ? `<p class="imp-warn">That's longer than one import can take. Trim it, or split it across two runs.</p>` : ""}
      </div>
    `;
  }

  // ── Step 2: Details ────────────────────────────────────────────────────────

  function renderDetails(draft) {
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Anything I should know?</h3>
        <p class="imp-step__lede">
          Optional. If your notes use shorthand — tally marks, initials, a
          column that isn't obvious — say so and the read comes out better.
        </p>
        <textarea id="imp-hint" class="imp-textarea imp-textarea--short" rows="4"
                  maxlength="${window.PlayImport.maxHintChars}"
                  placeholder="Each tally mark is one game that person won. Scores only appear for the biggest win and the closest game."
                  aria-label="How your notes are organised"
                  oninput="${V}._onHintInput(this.value)">${escapeHtml(draft.hint)}</textarea>
        <div class="imp-examples">
          <div class="imp-examples__label">For example</div>
          <button class="imp-example" type="button"
                  onclick="${call("_useHint", "Each tally mark is one game that person won. Scores only appear for the biggest win and the closest game.")}">
            Each tally mark is one game that person won…
          </button>
          <button class="imp-example" type="button"
                  onclick="${call("_useHint", "Left column is who won, right column is everyone who played. x4 means we played it four times.")}">
            Left column is who won, right column is who played…
          </button>
        </div>
      </div>
    `;
  }

  // ── Step 3: Players ────────────────────────────────────────────────────────

  function renderPlayers(draft, opts) {
    const loading = opts && opts.loadingPartners;
    if (!draft.playerNames.length) {
      return emptyStep("No players found", "The read didn't turn up any player names. Go back and check what you pasted.");
    }
    const rows = draft.playerNames.map((name) => {
      const m = draft.playerMapping(name);
      const buddy = m.kind === "buddy";
      const badge = window.BgbBadge.render({
        displayName: m.label || name,
        size: "sm",
        isGhost: !buddy,
        extraClass: "imp-row__badge",
      });
      // The mapped label is only worth printing when it differs from what the
      // note said — "Jas → Jasmine" is information, "Sean → Sean" is noise.
      const changed = String(m.label || "").toLowerCase() !== String(name).toLowerCase();
      return `
        <button class="imp-row" type="button" onclick="${call("_openPlayerSheet", name)}">
          ${badge}
          <span class="imp-row__body">
            <span class="imp-row__name">${escapeHtml(name)}</span>
            <span class="imp-row__sub">
              ${buddy
                ? `<i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i> ${escapeHtml(changed ? m.label : "Your buddy")}`
                : `Ghost player${changed ? ` — ${escapeHtml(m.label)}` : ""}`}
            </span>
          </span>
          <span class="imp-row__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
        </button>
      `;
    }).join("");

    const ghosts = draft.playerNames.filter((n) => draft.playerMapping(n).kind === "ghost").length;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Who played?</h3>
        <p class="imp-step__lede">
          ${draft.playerNames.length} name${draft.playerNames.length === 1 ? "" : "s"} came out of your notes.
          Match anyone who has an account; the rest come in as ghost players.
          ${ghosts ? `They can claim themselves later.` : ""}
        </p>
        ${loading ? `<p class="imp-note">Loading your buddies…</p>` : ""}
        <div class="imp-list">${rows}</div>
        <p class="imp-note">
          Two spellings of one person? Point them at the same buddy, or give
          them the same ghost name, and they'll land as one player.
        </p>
      </div>
    `;
  }

  // ── Step 4: Games ──────────────────────────────────────────────────────────

  function renderGames(draft) {
    if (!draft.gameRefs.length) {
      return emptyStep("No games found", "The read didn't turn up any game names. Go back and check what you pasted.");
    }
    const counts = {};
    for (const p of draft.plays) {
      if (p.dropped) continue;
      const k = String(p.gameName || "").trim().toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
    }
    const rows = draft.gameRefs.map((ref) => {
      const g = draft.gameMapping(ref.name);
      const n = counts[String(ref.name || "").trim().toLowerCase()] || 0;
      const art = g && g.thumbnail_url
        ? `<img class="imp-row__art" src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="imp-row__art imp-row__art--blank"><i data-icon="dices" class="w-4 h-4"></i></span>`;
      return `
        <button class="imp-row${g ? "" : " imp-row--unset"}" type="button"
                onclick="${call("_openGameSheet", ref.name)}">
          ${art}
          <span class="imp-row__body">
            <span class="imp-row__name">${escapeHtml(ref.name)}</span>
            <span class="imp-row__sub">
              ${g
                ? `<i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i> ${escapeHtml(g.name)} · ${n} play${n === 1 ? "" : "s"}`
                : `Pick a game · ${n} play${n === 1 ? "" : "s"} waiting`}
            </span>
          </span>
          <span class="imp-row__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
        </button>
      `;
    }).join("");

    const unresolved = draft.unresolvedGames();
    const cost = unresolved.reduce((a, u) => a + u.plays, 0);
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Which games?</h3>
        <p class="imp-step__lede">
          Every play needs a game from the library. I've matched what I could —
          check the rest.
        </p>
        <div class="imp-list">${rows}</div>
        ${unresolved.length ? `
          <p class="imp-warn">
            ${unresolved.length} game${unresolved.length === 1 ? "" : "s"} still unmatched.
            Continuing leaves ${cost} play${cost === 1 ? "" : "s"} out of the import.
          </p>
        ` : ""}
      </div>
    `;
  }

  // ── Step 5: Plays ──────────────────────────────────────────────────────────

  function renderPlays(draft, opts) {
    const groups = draft.groups();
    const shown = (opts && opts.shownGroups) || groups.length;
    const expanded = (opts && opts.expanded) || {};
    if (!groups.length) {
      return emptyStep("Nothing left to import", "Every play has been dropped. Go back a step, or start over.");
    }
    const body = groups.slice(0, shown).map((group) =>
      renderGroup(draft, group, expanded)
    ).join("");
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">${draft.liveCount} play${draft.liveCount === 1 ? "" : "s"}</h3>
        ${draft.warnings.length ? `
          <div class="imp-warnings">
            <div class="imp-warnings__label">Worth checking</div>
            <ul>${draft.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
          </div>
        ` : ""}
        <div class="imp-bulkdate">
          <label class="imp-bulkdate__label" for="imp-bulk-date">Date for plays without one</label>
          <input id="imp-bulk-date" class="imp-date" type="date" max="${window.PlayImport.today}"
                 value="${escapeAttr(draft.bulkDate || window.PlayImport.today)}"
                 onchange="${V}._onBulkDate(this.value)" />
        </div>
        <div class="imp-groups">${body}</div>
        ${shown < groups.length ? `<div data-imp-sentinel class="imp-sentinel" aria-hidden="true"></div>` : ""}
      </div>
    `;
  }

  function renderGroup(draft, group, expanded) {
    const rows = window.PlayImport.rows(group.plays);
    return `
      <section class="imp-group">
        <header class="imp-group__head">
          <span class="imp-group__name">${escapeHtml(group.name)}</span>
          <span class="imp-group__count">${group.plays.length}</span>
        </header>
        ${rows.map((row) => renderRow(draft, row, expanded)).join("")}
      </section>
    `;
  }

  /**
   * One review row. A run of identical repeats is one row carrying all of
   * them — a 58-play run as 58 rows is a list nobody scrolls, and every row
   * would say the same thing.
   */
  function renderRow(draft, row, expanded) {
    const first = row.plays[0];
    const n = row.plays.length;
    const open = !!expanded[first.id];
    const winners = first.players.filter((p) => p.isWinner);
    const summary = winners.length === 0
      ? "No winner recorded"
      : (winners.length > 1
        ? `Tie — ${winners.map((p) => escapeHtml(labelFor(draft, p.name))).join(" & ")}`
        : `${escapeHtml(labelFor(draft, winners[0].name))} won`);
    return `
      <div class="imp-play${open ? " is-open" : ""}">
        <button class="imp-play__head" type="button" aria-expanded="${open}"
                onclick="${call("_toggleRow", first.id)}">
          <span class="imp-play__chev"><i data-icon="${open ? "chevron-down" : "chevron-right"}" class="w-4 h-4"></i></span>
          <span class="imp-play__body">
            <span class="imp-play__title">
              ${n > 1 ? `${n} identical plays` : formatDate(draft.dateFor(first))}
            </span>
            <span class="imp-play__sub">
              ${summary}${n > 1 ? ` · ${formatDate(draft.dateFor(first))}` : ""}
            </span>
          </span>
          <span class="imp-play__drop" role="button" tabindex="0"
                aria-label="Remove ${n > 1 ? `these ${n} plays` : "this play"}"
                onclick="event.stopPropagation();${call("_dropRow", first.id)}">
            <i data-icon="trash-2" class="w-4 h-4"></i>
          </span>
        </button>
        ${open ? renderRowDetail(draft, row) : ""}
      </div>
    `;
  }

  function renderRowDetail(draft, row) {
    const first = row.plays[0];
    const game = draft.playGame(first);
    const players = first.players.map((p) => {
      const m = draft.playerMapping(p.name);
      return `
        <li class="imp-seat${p.isWinner ? " is-winner" : ""}">
          ${window.BgbBadge.render({
            displayName: m.label || p.name,
            size: "xs",
            isGhost: m.kind !== "buddy",
            extraClass: "imp-seat__badge",
          })}
          <span class="imp-seat__name">${escapeHtml(m.label || p.name)}</span>
          ${p.score != null ? `<span class="imp-seat__score">${p.score}</span>` : ""}
          ${p.isWinner ? `<span class="imp-seat__win"><i data-icon="trophy" class="w-3.5 h-3.5"></i></span>` : ""}
        </li>
      `;
    }).join("");
    return `
      <div class="imp-play__detail">
        <ul class="imp-seats">${players}</ul>
        ${first.notes ? `<p class="imp-play__notes">${escapeHtml(first.notes)}</p>` : ""}
        <div class="imp-play__fields">
          <label class="imp-field">
            <span class="imp-field__label">Date</span>
            <input class="imp-date" type="date" max="${window.PlayImport.today}"
                   value="${escapeAttr(draft.dateFor(first))}"
                   onchange="${escapeAttr(`${V}._onRowDate('${jsStr(first.id)}', this.value)`)}" />
          </label>
          <button class="imp-field imp-field--btn" type="button"
                  onclick="${call("_openRowGameSheet", first.id)}">
            <span class="imp-field__label">Game</span>
            <span class="imp-field__value">${escapeHtml(game ? game.name : "Not matched")}</span>
          </button>
        </div>
        ${row.plays.length > 1 ? `
          <label class="imp-field imp-field--count">
            <span class="imp-field__label">How many plays</span>
            <input class="imp-count-input" type="number" min="1" max="300" step="1"
                   value="${row.plays.length}"
                   aria-label="Number of plays in this run"
                   onchange="${escapeAttr(`${V}._onRunCount('${jsStr(first.id)}', this.value)`)}" />
          </label>
          <p class="imp-note">
            Editing anything else here changes all ${row.plays.length} — they
            came from one run of repeats in your notes. If the tally was
            misread, correct the number above.
          </p>
        ` : ""}
      </div>
    `;
  }

  function labelFor(draft, name) {
    const m = draft.playerMapping(name);
    return m.label || name;
  }

  // ── Step 6: Import ─────────────────────────────────────────────────────────

  function renderImport(draft, opts) {
    const busy = !!(opts && opts.importing);
    const done = draft.progress && draft.progress.done >= draft.progress.total;
    const importable = draft.importable().length;
    const skipped = draft.liveCount - importable;
    const groups = draft.groups().filter((g) => g.game);
    const buddies = draft.playerNames.filter((n) => draft.playerMapping(n).kind === "buddy").length;
    const ghosts = draft.playerNames.length - buddies;

    if (draft.progress && (busy || done)) {
      return renderProgress(draft, busy);
    }
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Ready to import</h3>
        <dl class="imp-summary">
          <div><dt>Plays</dt><dd>${importable}</dd></div>
          <div><dt>Games</dt><dd>${groups.length}</dd></div>
          <div>
            <dt>Players</dt><dd>${buddies + ghosts}</dd>
            <div class="imp-summary__note">
              ${buddies} ${buddies === 1 ? "buddy" : "buddies"} ·
              ${ghosts} ghost${ghosts === 1 ? "" : "s"}
            </div>
          </div>
        </dl>
        <ul class="imp-bygame">
          ${groups.map((g) => `
            <li><span>${escapeHtml(g.name)}</span><span>${g.plays.length}</span></li>
          `).join("")}
        </ul>
        ${skipped ? `
          <p class="imp-warn">
            ${skipped} play${skipped === 1 ? "" : "s"} won't be imported — no game matched.
            Go back to Games to match ${skipped === 1 ? "it" : "them"}.
          </p>
        ` : ""}
        <button class="imp-cta" type="button" ${importable ? "" : "disabled"}
                onclick="${V}._startImport()">
          Import ${importable} play${importable === 1 ? "" : "s"}
        </button>
      </div>
    `;
  }

  function renderProgress(draft, busy) {
    const p = draft.progress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
    const failed = p.failed > 0;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">${busy ? "Importing…" : (failed ? "Import finished" : "Imported")}</h3>
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
          ${failed ? `
            <p class="imp-warn">
              ${p.failed} play${p.failed === 1 ? "" : "s"} didn't land. Everything else did —
              running the import again picks up only what's missing.
            </p>
            <button class="imp-cta imp-cta--ghost" type="button" onclick="${V}._startImport()">Try the rest again</button>
          ` : ""}
          <button class="imp-cta" type="button" onclick="${V}._finish()">
            ${failed ? "Done" : "See your plays"}
          </button>
        `}
      </div>
    `;
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  function emptyStep(title, body) {
    return `
      <div class="imp-step imp-step--empty">
        <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
        <h3 class="imp-step__title font-display">${escapeHtml(title)}</h3>
        <p class="imp-step__lede">${escapeHtml(body)}</p>
      </div>
    `;
  }

  window.ImportPlaysSteps = {
    source: renderSource,
    details: renderDetails,
    players: renderPlayers,
    games: renderGames,
    plays: renderPlays,
    import: renderImport,
  };
})();
