// @ts-check
// widgets/import-notes-steps.js — the notes importer's six step bodies.
//
// Pure functions of the draft (domain/play-import.js). Every one returns an
// HTML string and touches nothing; the view owns state, sheets and events.
// Same shell/bodies split as onboarding-deck.js / onboarding-deck-slides.js,
// along the seam that matters: what a step IS versus how the wizard moves
// between them.
//
// Handlers are inline `onclick="window.importNotesBranch._foo()"` strings — the
// project idiom, and what keeps these functions pure. Anything carrying a name
// the user typed goes through jsStr THEN escapeAttr; see helpers.js for why
// both layers are needed.

(function () {
  const V = "window.importNotesBranch";
  /** A handler attribute for a call with one user-typed string argument. */
  const call = (method, arg) => escapeAttr(`${V}.${method}('${jsStr(arg)}')`);

  // ── Step 1: Source ─────────────────────────────────────────────────────────

  function renderSource(draft, opts) {
    const used = draft.text.length;
    const max = window.PlayImport.maxChars;
    const over = used > max;
    const busy = !!(opts && opts.preparingPhotos);
    // A draft resumed after a refresh keeps its plays and loses its photos —
    // they are the one thing too big to save (see PlayImport#addPhoto). Left
    // unexplained that is a blank source step under a wizard full of plays.
    const photosWereDropped = !draft.photos.length && !draft.text.trim() && draft.plays.length > 0;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Your notes</h3>
        <p class="imp-step__lede">
          A list, a table, a page of tally marks — whatever you already keep.
          Paste it, or photograph the page. It gets read into plays you'll
          review before anything is saved.
        </p>
        ${photosWereDropped ? `
          <p class="imp-note">
            This import was read from photos. They aren't kept when the
            importer reopens, but everything they were read into is —
            carry on, or add photos again to read them afresh.
          </p>
        ` : ""}
        <textarea id="imp-source" class="imp-textarea" rows="${draft.photos.length ? 5 : 12}"
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
          ${draft.photoRoom ? `
            <label class="imp-filebtn${busy ? " is-busy" : ""}">
              <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*"
                     multiple ${busy ? "disabled" : ""}
                     onchange="${V}._onPhotoPick(event)" />
              <i data-icon="${busy ? "loader-2" : "image-plus"}" class="w-4 h-4${busy ? " animate-spin" : ""}"></i>
              <span>${busy ? "Preparing…" : (draft.photos.length ? "Add another" : "Add photos")}</span>
            </label>
          ` : ""}
          <span class="imp-count${over ? " is-over" : ""}">
            ${used.toLocaleString()} / ${max.toLocaleString()}
          </span>
        </div>
        ${renderPhotoStrip(draft, busy)}
        ${over ? `<p class="imp-warn">That's longer than one import can take. Trim it, or split it across two runs.</p>` : ""}
      </div>
    `;
  }

  /**
   * The pages, in the order they'll be read. Numbered rather than merely
   * ordered: "photo 2 was the blurred one" is the sentence someone needs when
   * a warning comes back naming a page, and a grid of thumbnails alone cannot
   * say which one it means.
   */
  function renderPhotoStrip(draft, busy) {
    if (!draft.photos.length && !busy) return "";
    const bytes = draft.photos.reduce((n, p) => n + (p.bytes || 0), 0);
    const tiles = draft.photos.map((photo, i) => `
      <li class="imp-photo">
        <img class="imp-photo__img" src="${escapeAttr(photo.url)}" alt="Photo ${i + 1} of your notes" />
        <span class="imp-photo__n">${i + 1}</span>
        <button class="imp-photo__x" type="button"
                aria-label="Remove photo ${i + 1}"
                onclick="${call("_removePhoto", photo.id)}">
          <i data-icon="x" class="w-3.5 h-3.5"></i>
        </button>
      </li>
    `).join("");
    return `
      <ul class="imp-photos">
        ${tiles}
        ${busy ? `<li class="imp-photo imp-photo--busy" aria-hidden="true"><i data-icon="loader-2" class="w-5 h-5 animate-spin"></i></li>` : ""}
      </ul>
      ${draft.photos.length ? `
        <p class="imp-note">
          ${draft.photos.length === 1
            ? `One page`
            : `${draft.photos.length} pages, read in this order`} ·
          ${(bytes / 1048576).toFixed(1)} MB.
          Blurred or cut-off handwriting is where a read goes wrong — check the
          whole page is in frame before continuing.
        </p>
      ` : ""}
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
          ${draft.playerNames.length} name${draft.playerNames.length === 1 ? "" : "s"} came out of your notes.
          I've matched the ones close to someone you play with — tap any row to
          pick a different buddy, or to search everyone on BoardgameBuddy.
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

  window.ImportNotesSteps = {
    source: renderSource,
    details: renderDetails,
    players: renderPlayers,
    games: renderGames,
  };
})();
