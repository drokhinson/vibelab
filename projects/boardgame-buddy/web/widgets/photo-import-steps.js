// @ts-check
// widgets/photo-import-steps.js — the photo importer's three step bodies.
//
// Pure functions of the draft (domain/photo-import.js). Every one returns an
// HTML string and touches nothing; the view (views/photo-import-view.js) owns
// state, sheets and events. Same shell/bodies split as
// widgets/import-plays-steps.js, for the same reason.
//
// Handlers are inline `onclick="window.photoImportView._foo()"` strings — the
// project idiom, and what keeps these functions pure. Anything carrying a
// name the user typed goes through jsStr THEN escapeAttr; see helpers.js.

(function () {
  const V = "window.photoImportView";
  /** A handler attribute for a call with one user-typed string argument. */
  const call = (method, arg) => escapeAttr(`${V}.${method}('${jsStr(arg)}')`);

  /** Country as a line of prose, plus where the answer came from. */
  function placeLine(shot) {
    if (!shot.countryCode) return "No location in this photo";
    const name = window.Geo ? window.Geo.countryName(shot.countryCode) : shot.countryCode;
    if (shot.countrySource === "photo") return escapeHtml(name);
    if (shot.countrySource === "sibling") return `${escapeHtml(name)} — from another photo that day`;
    return escapeHtml(name);
  }

  function dateLine(shot) {
    const when = formatDate(shot.playedAt);
    if (shot.dateSource === "file") return `${escapeHtml(when)} — from the file, not the photo`;
    return escapeHtml(when);
  }

  // ── Step 1: Photos ─────────────────────────────────────────────────────────

  function renderPhotos(draft, opts) {
    const busy = !!(opts && opts.reading);
    const read = (opts && opts.readProgress) || null;
    const n = draft.shots.length;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Pick your photos</h3>
        <p class="imp-step__lede">
          Photos of games you've already played. Each one becomes a play, dated
          and placed from what your camera wrote into it — you say which game
          and who was there. Nothing is uploaded until the last step.
        </p>

        <div class="imp-step__foot-row">
          ${draft.room ? `
            <label class="imp-filebtn${busy ? " is-busy" : ""}">
              <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*"
                     multiple ${busy ? "disabled" : ""}
                     onchange="${V}._onPick(event)" />
              <i data-icon="${busy ? "loader-2" : "image-plus"}" class="w-4 h-4${busy ? " animate-spin" : ""}"></i>
              <span>${busy ? "Reading…" : (n ? "Add more" : "Choose photos")}</span>
            </label>
          ` : `<p class="imp-note">That's the most photos one run can take (${window.PhotoImport.maxShots}).</p>`}
          ${n ? `<span class="imp-count">${n} / ${window.PhotoImport.maxShots}</span>` : ""}
        </div>

        ${busy && read ? `
          <p class="imp-note" aria-live="polite">Reading photo ${read.done} of ${read.total}…</p>
        ` : ""}

        ${draft.photosLost ? `
          <p class="imp-note">
            This import was already under way. The pictures themselves aren't
            kept when the importer reopens, but the dates, places and everything
            you'd matched are — those plays still import, just without their
            photographs. Anything you add now is a play of its own on top.
          </p>
        ` : ""}

        ${n ? renderShotList(draft) : renderPickEmpty()}
      </div>
    `;
  }

  function renderPickEmpty() {
    return `
      <div class="pimp-empty">
        <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
        <p class="imp-step__lede imp-step__lede--center">
          Photos straight off a phone carry the day they were taken, and often
          the country too. A screenshot or a picture saved from a chat usually
          doesn't — those still work, you'll just fill the date in yourself.
        </p>
      </div>
    `;
  }

  function renderShotList(draft) {
    const rows = draft.shots.map((shot, i) => `
      <li class="pimp-pick">
        ${thumb(shot, `Photo ${i + 1}`)}
        <span class="pimp-pick__body">
          <span class="pimp-pick__name">${escapeHtml(shot.label || `Photo ${i + 1}`)}</span>
          <span class="pimp-pick__meta">
            <i data-icon="clock" class="w-3.5 h-3.5"></i> ${dateLine(shot)}
          </span>
          <span class="pimp-pick__meta">
            <i data-icon="flag" class="w-3.5 h-3.5"></i> ${placeLine(shot)}
          </span>
        </span>
        <button class="pimp-pick__x" type="button"
                aria-label="Remove ${escapeAttr(shot.label || `photo ${i + 1}`)}"
                onclick="${call("_removeShot", shot.id)}">
          <i data-icon="x" class="w-4 h-4"></i>
        </button>
      </li>
    `).join("");
    const withPlace = draft.shots.filter((s) => s.countryCode).length;
    const fromFile = draft.shots.filter((s) => s.dateSource === "file").length;
    return `
      <ul class="pimp-picks">${rows}</ul>
      <p class="imp-note">
        ${draft.shots.length} photo${draft.shots.length === 1 ? "" : "s"} ·
        ${withPlace} with a location${fromFile ? ` · ${fromFile} dated from the file rather than the photo` : ""}.
        Several photos of one game? Remove the spares — one photo is one play.
      </p>
    `;
  }

  // ── Step 2: Assign ─────────────────────────────────────────────────────────

  function renderAssign(draft, opts) {
    const shot = draft.current;
    if (!shot) {
      return emptyStep("No photos left", "Go back a step and pick some photos.");
    }
    const i = draft.cursor;
    const total = draft.shots.length;
    const canCopy = i > 0 && !!(draft.shots[i - 1].game || draft.shots[i - 1].players.length);
    return `
      <div class="imp-step pimp-assign">
        <div class="pimp-filmstrip" data-pimp-strip>
          ${draft.shots.map((s, n) => `
            <button class="pimp-film${n === i ? " is-current" : ""}${s.game ? " is-done" : ""}"
                    type="button" aria-label="Photo ${n + 1} of ${total}"
                    aria-current="${n === i ? "true" : "false"}"
                    onclick="${V}._goTo(${n})">
              ${thumb(s, `Photo ${n + 1}`)}
            </button>
          `).join("")}
        </div>

        <div class="pimp-hero">
          ${shot.url
            ? `<img class="pimp-hero__img" src="${escapeAttr(shot.url)}" alt="Photo ${i + 1} of ${total}" />`
            : `<div class="pimp-hero__gone">
                 <i data-icon="image-off" class="w-6 h-6"></i>
                 <span>The picture isn't here any more — everything you fill in still imports.</span>
               </div>`}
        </div>

        <div class="pimp-fields">
          <button class="pimp-field${shot.game ? "" : " pimp-field--unset"}" type="button"
                  onclick="${V}._openGameSheet()">
            <span class="pimp-field__mark">
              ${shot.game && shot.game.thumbnail_url
                ? `<img src="${escapeAttr(shot.game.thumbnail_url)}" alt="" loading="lazy" decoding="async" />`
                : `<i data-icon="dices" class="w-4 h-4"></i>`}
            </span>
            <span class="pimp-field__body">
              <span class="pimp-field__label">Game</span>
              <span class="pimp-field__value">${shot.game ? escapeHtml(shot.game.name) : "Pick a game"}</span>
            </span>
            <span class="pimp-field__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
          </button>

          <button class="pimp-field${shot.players.length ? "" : " pimp-field--unset"}" type="button"
                  onclick="${V}._openPlayerSheet()">
            <span class="pimp-field__mark"><i data-icon="users" class="w-4 h-4"></i></span>
            <span class="pimp-field__body">
              <span class="pimp-field__label">Players</span>
              <span class="pimp-field__value">
                ${shot.players.length
                  ? escapeHtml(shot.players.map((p) => p.name).join(", "))
                  : "Who played?"}
              </span>
            </span>
            <span class="pimp-field__chev"><i data-icon="chevron-right" class="w-4 h-4"></i></span>
          </button>
        </div>

        ${shot.players.length ? renderSeats(shot) : ""}

        <div class="pimp-meta">
          <label class="imp-field">
            <span class="imp-field__label">Date</span>
            <input class="imp-date" type="date" max="${window.PhotoImport.today}"
                   value="${escapeAttr(shot.playedAt)}"
                   aria-label="Date this was played"
                   onchange="${V}._onDate(this.value)" />
          </label>
          <button class="imp-field imp-field--btn" type="button" onclick="${V}._openCountrySheet()">
            <span class="imp-field__label">Where</span>
            <span class="imp-field__value">
              ${shot.countryCode
                ? escapeHtml(window.Geo ? window.Geo.countryName(shot.countryCode) : shot.countryCode)
                : "Not recorded"}
            </span>
          </button>
        </div>
        ${shot.dateSource === "exif" || shot.countrySource === "photo" ? `
          <p class="imp-note">
            ${shot.dateSource === "exif" && shot.countrySource === "photo"
              ? "The date and the country came out of this photo."
              : (shot.dateSource === "exif"
                  ? "The date came out of this photo."
                  : "The country came out of this photo.")}
            Change either if it's wrong.
          </p>
        ` : ""}

        <label class="pimp-notes">
          <span class="imp-field__label">Notes</span>
          <textarea class="imp-textarea imp-textarea--short" rows="2"
                    id="pimp-notes-${escapeAttr(shot.id)}"
                    placeholder="Optional — anything worth remembering about this one."
                    aria-label="Notes for this play"
                    onchange="${V}._onNotes(this.value)">${escapeHtml(shot.notes || "")}</textarea>
        </label>

        <div class="pimp-rowacts">
          ${canCopy ? `
            <button class="imp-cta imp-cta--ghost" type="button" onclick="${V}._copyPrevious()">
              <i data-icon="copy" class="w-4 h-4"></i> Same as the last one
            </button>
          ` : ""}
          <button class="pimp-drop" type="button" onclick="${V}._dropCurrent()">
            <i data-icon="trash-2" class="w-4 h-4"></i> Don't import this photo
          </button>
        </div>
      </div>
    `;
  }

  /**
   * The seated players: each one a toggle for "did they win", with its own
   * remove control.
   *
   * A tie is several winners, so the win state is a toggle rather than a radio
   * group — the same rule the live play flow's Settle Up screen follows. The
   * two controls are siblings inside the pill rather than one nested in the
   * other, because a button inside a button is not something a browser will
   * render, and the × has to be reachable on its own.
   */
  function renderSeats(shot) {
    return `
      <ul class="pimp-seats">
        ${shot.players.map((p) => `
          <li class="pimp-seat${p.isWinner ? " is-winner" : ""}">
            <button class="pimp-seat__toggle" type="button"
                    aria-pressed="${p.isWinner ? "true" : "false"}"
                    aria-label="${escapeAttr(p.isWinner ? `${p.name} won` : `Mark ${p.name} the winner`)}"
                    onclick="${call("_toggleWinner", p.name)}">
              ${window.BgbBadge.render({
                displayName: p.name,
                size: "xs",
                isGhost: !p.userId,
                extraClass: "pimp-seat__badge",
              })}
              <span class="pimp-seat__name">${escapeHtml(p.name)}</span>
              <span class="pimp-seat__win"><i data-icon="trophy" class="w-3.5 h-3.5"></i></span>
            </button>
            <button class="pimp-seat__x" type="button"
                    aria-label="${escapeAttr(`Remove ${p.name} from this table`)}"
                    onclick="${call("_removeSeat", p.name)}">
              <i data-icon="x" class="w-3.5 h-3.5"></i>
            </button>
          </li>
        `).join("")}
      </ul>
      <p class="imp-note">Tap a player to mark them the winner — several is a tie. × takes them off this table.</p>
    `;
  }

  // ── Step 3: Import ─────────────────────────────────────────────────────────

  function renderImport(draft, opts) {
    const busy = !!(opts && opts.importing);
    const done = draft.progress && draft.progress.done >= draft.progress.total;
    if (draft.progress && (busy || done)) return renderProgress(draft, busy);

    const ready = draft.importable();
    const missing = draft.unassigned();
    const withPhoto = ready.filter((s) => s.file || s.photoUrl).length;
    const seatless = ready.filter((s) => !s.players.length).length;
    const games = {};
    for (const s of ready) games[s.game.name] = (games[s.game.name] || 0) + 1;

    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">Ready to import</h3>
        <dl class="imp-summary">
          <div><dt>Plays</dt><dd>${ready.length}</dd></div>
          <div><dt>Games</dt><dd>${Object.keys(games).length}</dd></div>
          <div>
            <dt>Photos</dt><dd>${withPhoto}</dd>
            ${withPhoto < ready.length
              ? `<div class="imp-summary__note">${ready.length - withPhoto} without one</div>`
              : ""}
          </div>
        </dl>
        <ul class="imp-bygame">
          ${Object.keys(games).map((name) => `
            <li><span>${escapeHtml(name)}</span><span>${games[name]}</span></li>
          `).join("")}
        </ul>
        ${missing.length ? `
          <p class="imp-warn">
            ${missing.length} photo${missing.length === 1 ? "" : "s"} still ${missing.length === 1 ? "has" : "have"} no game,
            so ${missing.length === 1 ? "it won't" : "they won't"} be imported.
            Go back to match ${missing.length === 1 ? "it" : "them"}.
          </p>
        ` : ""}
        ${seatless ? `
          <p class="imp-note">
            ${seatless} play${seatless === 1 ? "" : "s"} ${seatless === 1 ? "has" : "have"} nobody at the table.
            ${seatless === 1 ? "It still imports" : "They still import"} — but ${seatless === 1 ? "it won't" : "they won't"}
            count towards anyone's record.
          </p>
        ` : ""}
        <button class="imp-cta" type="button" ${ready.length ? "" : "disabled"}
                onclick="${V}._startImport()">
          Import ${ready.length} play${ready.length === 1 ? "" : "s"}
        </button>
        <p class="imp-note">
          The photos go up first, then the plays. Leaving the screen mid-run
          stops it; everything already saved stays saved.
        </p>
      </div>
    `;
  }

  function renderProgress(draft, busy) {
    const p = draft.progress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
    const failed = p.failed > 0;
    // The first half of the bar is photos, the second is plays — worth saying,
    // because the two halves move at very different speeds and a bar that
    // crawls then sprints reads as a bar that is stuck.
    const uploading = busy && p.done < p.total / 2;
    return `
      <div class="imp-step">
        <h3 class="imp-step__title font-display">
          ${busy ? (uploading ? "Uploading photos…" : "Saving plays…") : (failed ? "Import finished" : "Imported")}
        </h3>
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
          ${p.photosFailed ? `
            <p class="imp-note">
              ${p.photosFailed} photo${p.photosFailed === 1 ? "" : "s"} didn't upload.
              ${p.photosFailed === 1 ? "That play" : "Those plays"} landed without
              ${p.photosFailed === 1 ? "it" : "them"} — you can add a photo from the play itself later.
            </p>
          ` : ""}
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

  /** A shot's thumbnail, or the placeholder a restored draft gets. */
  function thumb(shot, alt) {
    if (shot.url) {
      return `<img class="pimp-thumb" src="${escapeAttr(shot.url)}" alt="${escapeAttr(alt)}" />`;
    }
    return `<span class="pimp-thumb pimp-thumb--gone" aria-label="${escapeAttr(alt)}">
              <i data-icon="image-off" class="w-4 h-4"></i>
            </span>`;
  }

  function emptyStep(title, body) {
    return `
      <div class="imp-step imp-step--empty">
        <img class="imp-empty__art" src="assets/illustrations/bgb-loading.svg" alt="" />
        <h3 class="imp-step__title font-display">${escapeHtml(title)}</h3>
        <p class="imp-step__lede">${escapeHtml(body)}</p>
      </div>
    `;
  }

  window.PhotoImportSteps = {
    photos: renderPhotos,
    assign: renderAssign,
    import: renderImport,
  };
})();
