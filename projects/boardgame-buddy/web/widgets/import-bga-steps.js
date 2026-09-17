// @ts-check
// widgets/import-bga-steps.js — the Board Game Arena source's four step bodies.
//
// Pure functions of the draft (domain/bga-import.js). Every one returns an HTML
// string and touches nothing; the branch owns state, sheets and events. Same
// split as widgets/import-notes-steps.js, and the Players and Games steps are
// deliberately near-clones of theirs — one screen, one look, whichever source
// the user came in through (.claude/rules/ui-object-design.md §3a).
//
// Handlers are inline `onclick="window.importBgaBranch._foo()"` strings — the
// project idiom, and what keeps these functions pure. Anything carrying a name
// the user typed goes through jsStr THEN escapeAttr.

(function () {
  const V = "window.importBgaBranch";
  /** A handler attribute for a call with one user-typed string argument. */
  const call = (method, arg) => escapeAttr(`${V}.${method}('${jsStr(arg)}')`);

  // ── Step 1: Account ────────────────────────────────────────────────────────

  /**
   * The consent surface, and the only place an account can be unlinked.
   *
   * THE DISCLOSURE IS NOT BEHIND A DISCLOSURE. Board Game Arena's terms
   * prohibit automated access, this needs a real account password because BGA
   * has no API and no app passwords, and both facts are things a person should
   * read before typing rather than find out afterwards. The acknowledgement
   * checkbox gates Continue through `continueBlocker("account")`.
   *
   * There is no Settings → Connections row for this, which is a deliberate
   * product decision with one consequence: Unlink lives here or nowhere. A
   * user who can link and cannot unlink has not really consented.
   */
  function renderAccount(draft, opts) {
    const linked = draft.link.authState === "linked";
    const relink = draft.link.authState === "relink_required";
    const busy = !!(opts && opts.linking);

    if (linked) {
      return `
        <div class="imp-step">
          <h3 class="imp-step__title font-display">Board Game Arena</h3>
          <p class="imp-step__lede">
            You're signed in, so this can go straight to your finished tables.
          </p>
          <div class="imp-list">
            <div class="imp-row imp-row--static">
              <span class="imp-row__art"><i data-icon="gamepad-2" class="w-4 h-4"></i></span>
              <span class="imp-row__body">
                <span class="imp-row__name">${escapeHtml(draft.link.username || "")}</span>
                <span class="imp-row__sub">
                  <i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i> Linked
                </span>
              </span>
              <button class="btn btn-ghost btn-xs" type="button"
                      onclick="${V}._unlink()">Unlink</button>
            </div>
          </div>
          <p class="imp-note">
            Unlinking deletes the stored password and signs this importer out.
            Plays you've already imported stay where they are.
          </p>
        </div>
      `;
    }

    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Sign in to Board Game Arena</h3>
        <p class="imp-step__lede">
          Your finished tables come over with their date, their scores and
          everyone who was at them. You review every one before anything is
          saved.
        </p>

        ${relink ? `
          <p class="imp-warn">
            Your stored Board Game Arena sign-in can't be used any more. Sign in
            again to carry on importing.
          </p>
        ` : ""}

        <div class="imp-disclose">
          <p class="imp-disclose__line">
            <strong>Board Game Arena's terms don't allow automated access.</strong>
            Using this importer could put your BGA account at risk, up to
            suspension. Only you can decide whether that's worth it.
          </p>
          <p class="imp-disclose__line">
            BGA has no API and no app passwords, so importing needs your real
            account password. It's encrypted on our server and used for one
            thing: signing in to Board Game Arena as you. Keeping it is what
            lets your next import skip this screen.
          </p>
          <p class="imp-disclose__line">
            You can unlink here whenever you like, which deletes it.
          </p>
        </div>

        <label class="imp-field">
          <span class="imp-field__label">Board Game Arena username or email</span>
          <input id="imp-bga-user" class="imp-input" type="text" autocomplete="off"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 value="${escapeAttr((opts && opts.username) || "")}"
                 ${busy ? "disabled" : ""}
                 oninput="${V}._onUserInput(this.value)" />
        </label>

        <label class="imp-field">
          <span class="imp-field__label">Password</span>
          <input id="imp-bga-pass" class="imp-input" type="password" autocomplete="off"
                 ${busy ? "disabled" : ""}
                 oninput="${V}._onPassInput(this.value)" />
        </label>

        <label class="imp-check">
          <input type="checkbox" ${(opts && opts.agreed) ? "checked" : ""}
                 ${busy ? "disabled" : ""}
                 onchange="${V}._onAgree(this.checked)" />
          <span>
            I understand this uses my Board Game Arena account in a way their
            terms don't allow, and that the risk is mine.
          </span>
        </label>
      </div>
    `;
  }

  // ── Step 2: Fetch ──────────────────────────────────────────────────────────

  /**
   * Before, during and after the sweep.
   *
   * The sweep is minutes rather than seconds — up to five hundred tables
   * behind a two-second throttle — so a spinner here is indistinguishable from
   * a hang. The checklist is the server's own ledger, polled.
   */
  function renderFetch(draft, opts) {
    const busy = !!(opts && opts.fetching);
    const ledger = (opts && opts.fetchProgress) || null;

    if (busy || ledger) return renderLedger(draft, ledger, busy);

    if (draft.tables.length) {
      const n = draft.tables.length;
      return `
        <div class="imp-step">
          <h3 class="imp-step__title font-display">
            ${n} new table${n === 1 ? "" : "s"}
          </h3>
          <p class="imp-step__lede">
            ${draft.skipped
              ? `${draft.skipped} more ${draft.skipped === 1 ? "was" : "were"} already in your plays, so ${draft.skipped === 1 ? "it's" : "they're"} left out.`
              : `Nothing here has been imported before.`}
          </p>
          ${draft.truncated ? `
            <p class="imp-warn">
              This run stopped before the end of your history. Import these,
              then start another — nothing gets offered twice.
            </p>
          ` : ""}
          <p class="imp-note">
            Next you'll say who each Board Game Arena name is, then which game
            each table was.
          </p>
        </div>
      `;
    }

    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Find your tables</h3>
        <p class="imp-step__lede">
          This reads your finished games from Board Game Arena. It skips
          anything you've already imported, so you can run it as often as you
          like.
        </p>
        <p class="imp-note">
          It goes slowly on purpose — Board Game Arena is somebody else's
          server, and this asks politely. A long history can take a couple of
          minutes.
        </p>
      </div>
    `;
  }

  /** The sweep's checklist, straight off the server's ledger. */
  function renderLedger(draft, ledger, busy) {
    const steps = (ledger && ledger.steps) || [];
    // `unknown` with no steps is the honest answer from a worker that never
    // ran the sweep — it means "still working", never "done".
    const rows = steps.length
      ? steps.map((step) => {
        const icon = step.state === "done" ? "check"
          : step.state === "active" ? "loader-2"
            : step.state === "skipped" ? "minus" : "circle";
        const count = (step.total != null && step.done != null)
          ? ` · ${step.done}/${step.total}`
          : (step.done != null ? ` · ${step.done}` : "");
        return `
          <li class="imp-ledger__row is-${escapeAttr(step.state)}">
            <i data-icon="${icon}" class="w-4 h-4${step.state === "active" ? " animate-spin" : ""}"></i>
            <span class="imp-ledger__label">
              ${escapeHtml(phaseLabel(step.key))}${escapeHtml(count)}
            </span>
            ${step.detail ? `<span class="imp-ledger__detail">${escapeHtml(step.detail)}</span>` : ""}
          </li>
        `;
      }).join("")
      : `<li class="imp-ledger__row is-active">
           <i data-icon="loader-2" class="w-4 h-4 animate-spin"></i>
           <span class="imp-ledger__label">Working…</span>
         </li>`;

    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">
          ${busy ? "Reading Board Game Arena…" : "Finished reading"}
        </h3>
        <p class="imp-step__lede">
          Nothing is written yet. This is only the reading.
        </p>
        <ul class="imp-ledger">${rows}</ul>
        ${ledger && ledger.error ? `<p class="imp-warn">${escapeHtml(ledger.error)}</p>` : ""}
      </div>
    `;
  }

  /** Mirrors BgaFetchPhase in api/routes/constants.py. */
  function phaseLabel(phase) {
    switch (phase) {
      case "sign_in": return "Signing in";
      case "history": return "Reading your game history";
      case "known": return "Checking what you've already imported";
      case "detail": return "Reading each table";
      case "match": return "Matching games and players";
      default: return "Working";
    }
  }

  // ── Step 3: Players ────────────────────────────────────────────────────────

  /**
   * One row per Board Game Arena handle.
   *
   * EVERY ROW SAYS WHY. A handle is not a name — "Tiggy_42" tells you nothing
   * about whether the match is right — so the sub-line is the REASON rather
   * than a score (.claude/rules/web-frontend.md). "Matched before" and
   * "@handle is Marcus Chen on BoardgameBuddy" are different claims and the
   * second one is somebody else's, which is exactly what the user needs to
   * know to decide whether to leave it.
   */
  function renderPlayers(draft, opts) {
    const loading = opts && opts.loadingPartners;
    if (!draft.handles.length) {
      return emptyStep(
        "Nobody to match",
        "None of these tables named an opponent. Carry on to the games.",
      );
    }

    const rows = draft.handles.map((handle) => {
      const m = draft.playerMapping(handle);
      const buddy = m.kind === "buddy";
      const reason = draft.matchReason(handle);
      const badge = window.BgbBadge.render({
        displayName: m.label || handle,
        size: "sm",
        isGhost: !buddy,
        extraClass: "imp-row__badge",
      });
      return `
        <button class="imp-row" type="button" onclick="${call("_openPlayerSheet", handle)}">
          ${badge}
          <span class="imp-row__body">
            <span class="imp-row__name">${escapeHtml(handle)}</span>
            <span class="imp-row__sub">${reasonLine(reason, m, handle)}</span>
          </span>
          <span class="imp-row__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
        </button>
      `;
    }).join("");

    const ghosts = draft.handles
      .filter((h) => draft.playerMapping(h).kind === "ghost").length;

    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Who are these people?</h3>
        <p class="imp-step__lede">
          ${draft.handles.length} Board Game Arena name${draft.handles.length === 1 ? "" : "s"}
          turned up at your tables. Tap any row to pick a different buddy, or to
          search everyone on BoardgameBuddy.
          ${ghosts ? `Whoever's left comes in as a ghost player, and can claim themselves later.` : ""}
        </p>
        ${loading ? `<p class="imp-note">Loading your buddies…</p>` : ""}
        <div class="imp-list">${rows}</div>
        <p class="imp-note">
          Whatever you set here is remembered, so your next Board Game Arena
          import won't ask again.
        </p>
      </div>
    `;
  }

  /** The sub-line: why this row says what it says. */
  function reasonLine(reason, mapping, handle) {
    const name = escapeHtml(mapping.label || handle);
    const ok = `<i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i>`;
    switch (reason) {
      case "viewer":
        return `${ok} You`;
      case "remembered":
        return `${ok} ${name} — matched before`;
      case "cross_account":
        return `${ok} ${name} on BoardgameBuddy uses this name`;
      case "user":
        return mapping.kind === "buddy" ? `${ok} ${name}` : `Ghost player — ${name}`;
      case "fuzzy":
        return `${ok} ${name} — closest to “${escapeHtml(handle)}”`;
      default:
        return `New ghost player`;
    }
  }

  // ── Step 4: Games ──────────────────────────────────────────────────────────

  function renderGames(draft) {
    if (!draft.gameRefs.length) {
      return emptyStep(
        "No games to match",
        "These tables didn't name a game. Go back and read your history again.",
      );
    }
    const counts = {};
    for (const t of draft.tables) {
      if (t.dropped) continue;
      const k = String(t.gameName || "").trim().toLowerCase();
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
                ? `<i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i> ${escapeHtml(g.name)} · ${n} table${n === 1 ? "" : "s"}`
                : `Pick a game · ${n} table${n === 1 ? "" : "s"} waiting`}
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
          Every play needs a game from the library. Board Game Arena's names
          don't always match ours — check the ones that didn't.
        </p>
        <div class="imp-list">${rows}</div>
        ${unresolved.length ? `
          <p class="imp-warn">
            ${unresolved.length} game${unresolved.length === 1 ? "" : "s"} still unmatched.
            Continuing leaves ${cost} table${cost === 1 ? "" : "s"} out of the import.
          </p>
        ` : ""}
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

  window.ImportBgaSteps = {
    account: renderAccount,
    fetch: renderFetch,
    players: renderPlayers,
    games: renderGames,
  };
})();
