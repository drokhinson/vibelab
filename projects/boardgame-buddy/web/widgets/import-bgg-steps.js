// @ts-check
// widgets/import-bgg-steps.js — the BoardGameGeek branch's three step bodies.
//
// Pure functions of the draft (domain/bgg-play-import.js). Every one returns an
// HTML string and touches nothing; the branch owns state, sheets and events.
// Same split as widgets/import-notes-steps.js, and the same `.imp-*` families —
// a BoardGameGeek name is matched with the gesture a pasted name is matched
// with, because it is the same act.
//
// Handlers are inline `onclick="window.importBggBranch._foo()"` strings — the
// project idiom, and what keeps these functions pure.

(function () {
  const V = "window.importBggBranch";
  /** A handler attribute for a call with one user-typed string argument. */
  const call = (method, arg) => escapeAttr(`${V}.${method}('${jsStr(arg)}')`);

  // ── Step 1: Plays ──────────────────────────────────────────────────────────

  /**
   * The read, and what it found.
   *
   * This is the branch's `source` equivalent, and the only step in the whole
   * wizard whose content arrives rather than being typed. Four states, and they
   * are genuinely four rather than a loading flag over one: reading, a dead
   * link (which is a pointer to Settings, not an error), nothing new (which is
   * good news and deserves to read like it), and a count.
   */
  function renderPlays(draft, opts) {
    const o = opts || {};
    if (o.loading) {
      return `
        <div class="imp-step imp-step--empty">
          ${window.buddyLoader({ size: 96, label: "Reading your plays…" })}
          <p class="imp-step__lede">
            BoardGameGeek hands these over a page at a time, so this can take a
            moment on a long history.
          </p>
        </div>
      `;
    }

    if (o.linkError) {
      return `
        <div class="imp-step imp-step--empty">
          <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <h3 class="imp-step__title font-display">No BoardGameGeek account linked</h3>
          <p class="imp-step__lede">${escapeHtml(o.linkError)}</p>
          <button class="btn btn-primary imp-step__cta" type="button"
                  onclick="${V}._goToConnections()">
            Open Connections
          </button>
        </div>
      `;
    }

    if (o.error) {
      return `
        <div class="imp-step imp-step--empty">
          <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <h3 class="imp-step__title font-display">That didn't finish</h3>
          <p class="imp-step__lede">${escapeHtml(o.error)}</p>
          <button class="btn btn-primary imp-step__cta" type="button"
                  onclick="${V}._loadPlays({ force: true })">Try again</button>
        </div>
      `;
    }

    const n = draft.plays.length;
    if (!n) {
      return `
        <div class="imp-step imp-step--empty">
          <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
          <h3 class="imp-step__title font-display">Nothing new to bring over</h3>
          <p class="imp-step__lede">
            Every play on
            ${draft.bggUsername ? `@${escapeHtml(draft.bggUsername)}` : "your BoardGameGeek account"}
            is already in BoardgameBuddy.
          </p>
          <button class="btn btn-ghost imp-step__cta" type="button"
                  onclick="${V}._loadPlays({ force: true })">Check again</button>
        </div>
      `;
    }

    const span = dateSpan(draft);
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Your BoardGameGeek plays</h3>
        <p class="imp-step__lede">
          <strong>${n}</strong> play${n === 1 ? "" : "s"} on
          ${draft.bggUsername ? `@${escapeHtml(draft.bggUsername)}` : "BoardGameGeek"}
          ${n === 1 ? "isn't" : "aren't"} in BoardgameBuddy yet${span ? ` — ${escapeHtml(span)}` : ""}.
          Nothing is written until you've reviewed every one.
        </p>
        ${draft.truncated ? `
          <p class="imp-warn">
            You have ${draft.totalNew} waiting in all. These are the newest ${n} —
            run this again afterwards for the rest.
          </p>
        ` : ""}
        <dl class="imp-summary">
          <div><dt>Plays</dt><dd>${n}</dd></div>
          <div><dt>Games</dt><dd>${draft.groups().length}</dd></div>
          <div><dt>Players</dt><dd>${draft.playerNames.length}</dd></div>
        </dl>
        <button class="btn btn-ghost imp-step__cta" type="button"
                onclick="${V}._loadPlays({ force: true })">Read them again</button>
      </div>
    `;
  }

  /** "Jan 2020 – Sep 2026", or null when there is nothing to span. */
  function dateSpan(draft) {
    const dates = draft.plays.map((p) => p.playedAt).filter(Boolean).sort();
    if (!dates.length) return null;
    const first = monthLabel(dates[0]);
    const last = monthLabel(dates[dates.length - 1]);
    return first === last ? first : `${first} – ${last}`;
  }

  function monthLabel(iso) {
    // Parsed by hand rather than through Date: `new Date("2026-01-02")` is
    // UTC midnight, which reads as the previous month in every timezone west
    // of Greenwich on the first of a month.
    const [y, m] = String(iso).split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[Number(m) - 1] || ""} ${y}`.trim();
  }

  // ── Step 2: Players ────────────────────────────────────────────────────────

  function renderPlayers(draft, opts) {
    const loading = opts && opts.loadingPartners;
    if (!draft.playerNames.length) {
      return emptyStep(
        "Nobody named",
        "These plays don't record who was at the table. They'll come in under "
        + "your own name — you can add the others in the review.",
      );
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
      // Only worth printing when it differs from what BGG said — "Jas →
      // Jasmine" is information, "Sean → Sean" is noise.
      const changed = String(m.label || "").toLowerCase() !== String(name).toLowerCase();
      return `
        <button class="imp-row" type="button" onclick="${call("_openPlayerSheet", name)}">
          ${badge}
          <span class="imp-row__body">
            <span class="imp-row__name">${escapeHtml(name)}</span>
            <span class="imp-row__sub">
              ${buddy
                ? `<i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i> ${escapeHtml(changed ? m.label : "Their account")}`
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
          ${draft.playerNames.length} name${draft.playerNames.length === 1 ? "" : "s"}
          came over with these plays. Anyone BoardGameGeek recorded as
          ${draft.bggUsername ? `@${escapeHtml(draft.bggUsername)}` : "you"} is already
          matched to your account — tap any row to pick a different buddy, or to
          search everyone on BoardgameBuddy.
          ${ghosts ? `Whoever's left comes in as a ghost player, and can claim themselves later.` : ""}
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

  // ── Step 3: Games ──────────────────────────────────────────────────────────

  /**
   * The games BgB has never heard of.
   *
   * Not a search, unlike the notes branch's equivalent: this branch holds
   * BoardGameGeek's own id for every game, which is the same id the catalog
   * stores. So the primary action is "bring it over", one BGG fetch, and the
   * search sheet is the fallback for a game that is already here under another
   * id.
   */
  function renderGames(draft, opts) {
    const busy = (opts && opts.importingGames) || {};
    const groups = draft.groups();
    if (!groups.length) {
      return emptyStep("No games", "There are no plays to match games for.");
    }
    const unresolved = draft.unresolvedGames();
    const rows = groups.map((group) => {
      const g = group.game;
      const first = group.plays[0];
      const n = group.plays.length;
      const pending = !!busy[first.bggGameId];
      const art = g && g.thumbnail_url
        ? `<img class="imp-row__art" src="${escapeAttr(g.thumbnail_url)}" alt="" loading="lazy" decoding="async" />`
        : `<span class="imp-row__art imp-row__art--blank"><i data-icon="dices" class="w-4 h-4"></i></span>`;
      if (g) {
        return `
          <div class="imp-row imp-row--static">
            ${art}
            <span class="imp-row__body">
              <span class="imp-row__name">${escapeHtml(g.name)}</span>
              <span class="imp-row__sub">
                <i data-icon="check" class="w-3.5 h-3.5 imp-row__ok"></i>
                In your library · ${n} play${n === 1 ? "" : "s"}
              </span>
            </span>
          </div>
        `;
      }
      return `
        <div class="imp-row imp-row--unset imp-row--static">
          ${art}
          <span class="imp-row__body">
            <span class="imp-row__name">${escapeHtml(first.bggGameName)}</span>
            <span class="imp-row__sub">
              Not in BoardgameBuddy yet · ${n} play${n === 1 ? "" : "s"} waiting
            </span>
          </span>
          <span class="imp-row__actions">
            <button class="btn btn-xs btn-primary" type="button" ${pending ? "disabled" : ""}
                    onclick="${V}._importOne(${Number(first.bggGameId)})">
              ${pending ? "Importing…" : "Bring it over"}
            </button>
            <button class="btn btn-xs btn-ghost" type="button" ${pending ? "disabled" : ""}
                    onclick="${call("_openGameSheet", String(first.bggGameId))}">
              Match
            </button>
          </span>
        </div>
      `;
    }).join("");

    const cost = unresolved.reduce((a, u) => a + u.plays, 0);
    const anyBusy = Object.keys(busy).length > 0;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Which games?</h3>
        <p class="imp-step__lede">
          Every play needs a game from the library. BoardgameBuddy already has
          most of them — bring the rest over from BoardGameGeek, or match one by
          hand if it's here under a different name.
        </p>
        <div class="imp-list">${rows}</div>
        ${unresolved.length ? `
          <p class="imp-warn">
            ${unresolved.length} game${unresolved.length === 1 ? "" : "s"} still missing.
            Continuing leaves ${cost} play${cost === 1 ? "" : "s"} out of the import.
          </p>
          <button class="btn btn-primary imp-step__cta" type="button" ${anyBusy ? "disabled" : ""}
                  onclick="${V}._importAllGames()">
            ${anyBusy ? "Bringing them over…" : `Bring over all ${unresolved.length}`}
          </button>
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

  window.ImportBggSteps = {
    plays: renderPlays,
    players: renderPlayers,
    games: renderGames,
  };
})();
