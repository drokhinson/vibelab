// @ts-check
// widgets/import-photos-steps.js — the photo importer's three step bodies.
//
// Pure functions of the draft (domain/photo-import.js). Every one returns an
// HTML string and touches nothing; the branch (widgets/import-photos-branch.js)
// owns state, sheets and events. Same shell/bodies split as the sibling
// import-*-steps.js files, for the same reason.
//
// Handlers are inline `onclick="window.importPhotosBranch._foo()"` strings — the
// project idiom, and what keeps these functions pure. Anything carrying a
// name the user typed goes through jsStr THEN escapeAttr; see helpers.js.

(function () {
  const V = "window.importPhotosBranch";
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
        ${shot.players.map((p) => {
          // Addressed by who they ARE, not by what the row says: an account and
          // a ghost can share a display name, and a name-keyed handler hits
          // both. window.PhotoImport.whoOf is the same key the model collapses
          // seats on and the same one the shared review uses.
          const who = window.PhotoImport.whoOf(p);
          return `
          <li class="pimp-seat${p.isWinner ? " is-winner" : ""}">
            <button class="pimp-seat__toggle" type="button"
                    aria-pressed="${p.isWinner ? "true" : "false"}"
                    aria-label="${escapeAttr(p.isWinner ? `${p.name} won` : `Mark ${p.name} the winner`)}"
                    onclick="${call("_toggleWinner", who)}">
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
                    onclick="${call("_removeSeat", who)}">
              <i data-icon="x" class="w-3.5 h-3.5"></i>
            </button>
          </li>
        `;
        }).join("")}
      </ul>
      <p class="imp-note">Tap a player to mark them the winner — several is a tie. × takes them off this table.</p>
    `;
  }

  // ── Step 3: Import ─────────────────────────────────────────────────────────

  // ── Shared ──────────────────────────────────────────────────────

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

  window.ImportPhotosSteps = {
    photos: renderPhotos,
    assign: renderAssign,
  };
})();
