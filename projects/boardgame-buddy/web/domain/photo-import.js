// @ts-check
// domain/photo-import.js — the photo importer's model.
//
// The other importer (domain/play-import.js) reads a written note: it sends
// text and photographs of a page to a model, gets draft plays back, and the
// wizard's job is to check the model's guesses. This one reads a CAMERA ROLL,
// and there is no model in it at all. A photo of a table already carries the
// two facts nobody can reconstruct later — the day and the place — in its EXIF
// block, and the two facts a file could never carry — which game and who
// played — are the ones the user is here to supply.
//
// Four things worth knowing before reading the view:
//
//   • ONE PHOTO IS ONE PLAY. Not a session, not a night. Somebody who shot
//     four photos of one game says so by removing three of them, which is one
//     tap each on the pick step; the alternative — grouping by time and place
//     and asking the user to un-group — guesses at the thing they came here to
//     tell us.
//
//   • THE PHOTO IS THE PLAY'S PHOTO. This is the whole reason the flow is
//     worth having over typing the plays in: the picture that told us the date
//     is also the picture that ends up on the card in the feed. It is uploaded
//     before the play is written and the URL memoised on the shot, so a retry
//     after a lost response never pushes the bytes twice.
//
//   • EVERY SHOT CARRIES ITS OWN client_key, exactly as play-import.js does,
//     and for exactly the same reason: bgb_log_play answers a key it already
//     holds with {duplicate: true}, so re-running a half-finished import lands
//     the rest and re-writes nothing.
//
//   • THE FILES ARE NOT SAVED, BUT EVERYTHING READ OFF THEM IS. localStorage
//     cannot hold thirty JPEGs, so a draft restored after a refresh keeps the
//     dates, countries, games and players and loses the pictures. Those plays
//     still import — without a photo — which is strictly better than throwing
//     away twenty minutes of assignment. The view says so on screen rather
//     than leaving a strip of dead thumbnails to explain itself.

(function () {
  const DRAFT_KEY = "bgb.photoImport.draft";
  // Bump when the draft shape changes; a stored draft at another version is
  // dropped rather than half-restored.
  const DRAFT_VERSION = 1;

  // Mirrors IMPORT_CHUNK_MAX in the backend's constants.py.
  const CHUNK_SIZE = 50;
  // One photo is one play AND one upload, so this caps a run at thirty round
  // trips of image bytes and thirty full-size bitmap decodes. Past that a
  // phone starts killing the tab for memory, and the assign pager becomes a
  // sitting rather than a task. Two runs are always allowed.
  const MAX_SHOTS = 30;
  const IMPORT_TIMEOUT_MS = 60000;

  // `review` is new: the pager used to run straight into the summary, and the
  // shared review now sits between them, so a photo import gets the same
  // considered last pass over its plays that a note always had.
  const STEPS = ["photos", "assign", "review", "import"];

  /**
   * @typedef {Object} DraftSeat
   * @property {string} name      What the play row records.
   * @property {string|null} userId  Set when this seat is a real account.
   * @property {boolean} isWinner
   * @property {number|null} [score]  Final score, entered in the review.
   *   Absent on every seat nobody typed a number into, which is most of them —
   *   a photo carries no score of its own the way a note can.
   */

  /**
   * @typedef {Object} DraftShot
   * @property {string} id        Local id — also the client_key sent to the API.
   * @property {string} label     File name, for the "photo 3 was the blurred one" sentence.
   * @property {File|null} file   Prepared for upload. Null on a restored draft.
   * @property {string|null} url  Object URL for the thumbnail. Revoked on removal.
   * @property {string} playedAt  ISO date.
   * @property {"exif"|"file"|"user"} dateSource
   * @property {string|null} countryCode  ISO 3166-1 alpha-2.
   * @property {"photo"|"sibling"|"user"|null} countrySource
   * @property {{id: string, name: string, thumbnail_url?: string|null}|null} game
   * @property {DraftSeat[]} players
   * @property {string|null} notes
   * @property {string|null} photoUrl  Set once uploaded; memoised across retries.
   */

  const uid = () => (
    (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
      })
  );

  const todayIso = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  class PhotoImport {
    constructor() {
      this.reset();
    }

    reset() {
      this.step = 0;
      /** Which shot the assign pager is on. */
      this.cursor = 0;
      this.releaseFiles();
      /** @type {DraftShot[]} */
      this.shots = [];
      /** True once a restore has come back without its files. */
      this.photosLost = false;
      /** @type {{done: number, total: number, imported: number, duplicate: number,
       *           failed: number, photosFailed: number, errors: string[]}|null} */
      this.progress = null;
    }

    static get steps() { return STEPS; }
    /**
     * A fresh shot id. UUID-shaped rather than merely unique, because it is
     * also the client_key, and PlayCreate.client_key is a UUID4 on the server
     * — a readable "ph-1712…" id would be a 422 for the whole chunk.
     */
    static newId() { return uid(); }
    static get maxShots() { return MAX_SHOTS; }
    static get today() { return todayIso(); }

    get stepName() { return STEPS[this.step] || STEPS[0]; }
    get room() { return Math.max(0, MAX_SHOTS - this.shots.length); }
    get isDirty() { return this.shots.length > 0; }

    /** Object URLs are a document-lifetime leak until they're revoked. */
    releaseFiles() {
      for (const s of this.shots || []) {
        if (s.url) { try { URL.revokeObjectURL(s.url); } catch (_) { /* already gone */ } }
      }
    }

    // ── Building the batch ───────────────────────────────────────────────────

    /** @param {DraftShot} shot */
    addShot(shot) {
      if (this.shots.length >= MAX_SHOTS) return false;
      this.shots.push(shot);
      return true;
    }

    /** @param {string} id */
    removeShot(id) {
      const i = this.shots.findIndex((s) => s.id === id);
      if (i === -1) return;
      const [gone] = this.shots.splice(i, 1);
      if (gone.url) { try { URL.revokeObjectURL(gone.url); } catch (_) { /* already gone */ } }
      if (this.cursor >= this.shots.length) this.cursor = Math.max(0, this.shots.length - 1);
    }

    /** @param {string} id @returns {DraftShot|null} */
    shotFor(id) { return this.shots.find((s) => s.id === id) || null; }

    /** The shot the assign pager is on. */
    get current() { return this.shots[this.cursor] || null; }

    /**
     * Photos taken on a day when ANOTHER photo in the same batch did know
     * where it was, inherit that country.
     *
     * Not a guess: phones write a GPS tag only when location services were on
     * for the camera at that moment, so one photo of an evening having it and
     * the next not is routine — a lock that hadn't landed yet, a shot taken
     * indoors after airplane mode. The day is the join key rather than the
     * clock hour because the play's own field is a DATE; two plays on one day
     * in two countries is a flight, and the picker is one tap away for it.
     */
    inferMissingCountries() {
      /** @type {Record<string, string>} */
      const byDay = {};
      for (const s of this.shots) {
        if (s.countryCode && s.countrySource === "photo" && !byDay[s.playedAt]) {
          byDay[s.playedAt] = s.countryCode;
        }
      }
      for (const s of this.shots) {
        if (s.countryCode) continue;
        const inherited = byDay[s.playedAt];
        if (!inherited) continue;
        s.countryCode = inherited;
        s.countrySource = "sibling";
      }
    }

    // ── Assignments ──────────────────────────────────────────────────────────

    setDate(id, value) {
      const s = this.shotFor(id);
      if (!s || !value) return;
      s.playedAt = value;
      s.dateSource = "user";
    }

    setCountry(id, code) {
      const s = this.shotFor(id);
      if (!s) return;
      s.countryCode = code ? String(code).toUpperCase() : null;
      s.countrySource = "user";
    }

    setGame(id, game) {
      const s = this.shotFor(id);
      if (!s) return;
      s.game = game
        ? { id: game.id, name: game.name, thumbnail_url: game.thumbnail_url || null }
        : null;
    }

    /** @param {string} id @param {DraftSeat[]} seats */
    setPlayers(id, seats) {
      const s = this.shotFor(id);
      if (!s) return;
      s.players = seats;
    }

    setNotes(id, value) {
      const s = this.shotFor(id);
      if (!s) return;
      const text = String(value || "").trim();
      s.notes = text || null;
    }

    /**
     * Take one seat off this table. Removing the last one is allowed while the
     * user is still assigning — mis-tapped, about to re-pick — but a shot left
     * with nobody at it is no longer importable (see importable), and both the
     * assign step and the last step say so.
     *
     * Addressed by whoOf(), not by the display name. An account and a ghost can
     * legitimately carry the same name — which is exactly what seats()'
     * collapse exists to keep apart — and a name-keyed handler unseats both.
     * @param {string} id @param {string} who A whoOf() key.
     */
    removeSeat(id, who) {
      const s = this.shotFor(id);
      if (!s) return;
      s.players = s.players.filter((p) => PhotoImport.whoOf(p) !== who);
    }

    /**
     * Toggle who won. Several winners is a tie and a legitimate answer, so
     * this is a toggle rather than a radio — the play flow's Settle Up screen
     * treats it the same way.
     * @param {string} id @param {string} who A whoOf() key.
     */
    toggleWinner(id, who) {
      const s = this.shotFor(id);
      if (!s) return;
      for (const p of s.players) {
        if (PhotoImport.whoOf(p) === who) p.isWinner = !p.isWinner;
      }
    }

    /**
     * One final score for one seat, entered in the review.
     *
     * Blank clears it back to null rather than writing 0 — a game nobody
     * recorded a score for is not a game everybody scored nothing in.
     * @param {string} id @param {string} who @param {string|number} value
     */
    setScore(id, who, value) {
      const s = this.shotFor(id);
      if (!s) return false;
      const raw = String(value == null ? "" : value).trim();
      const score = raw === "" ? null : Math.trunc(Number(raw));
      if (score != null && !Number.isFinite(score)) return false;
      for (const p of s.players) {
        if (PhotoImport.whoOf(p) === who) p.score = score;
      }
      return true;
    }

    /**
     * Seat more people at one table, from picker rows. Appends rather than
     * replaces — the sheet answers "who else" — and seats() collapses anyone
     * picked who is already there.
     * @param {string} id @param {any[]} picks PlayerCandidate rows.
     */
    addSeats(id, picks) {
      const s = this.shotFor(id);
      if (!s || !picks || !picks.length) return false;
      s.players = s.players.concat(picks.map((pick) => ({
        name: pick.name,
        userId: pick.user_id || null,
        isWinner: false,
        score: null,
      })));
      return true;
    }

    /**
     * Copy the game and the table from the shot before this one.
     *
     * The affordance the whole pager turns on: a camera roll from one evening
     * is the same six people playing two or three games, so every photo after
     * the first is one tap away from done. The date and the country are NOT
     * copied — those came out of this photo's own EXIF and are the one part
     * the importer already knows better than the user does.
     * @param {string} id
     */
    copyFromPrevious(id) {
      const i = this.shots.findIndex((s) => s.id === id);
      if (i <= 0) return false;
      const from = this.shots[i - 1];
      const to = this.shots[i];
      if (!from.game && !from.players.length) return false;
      to.game = from.game ? { ...from.game } : null;
      to.players = from.players.map((p) => ({ ...p }));
      return true;
    }

    // ── What can be written ──────────────────────────────────────────────────

    /**
     * THE SEATS OF ONE SHOT, AS THEY WILL BE WRITTEN — collapsed wherever two
     * rows turned out to be the same person.
     *
     * The picker adds seats rather than replacing them, and dedupes what it
     * adds by DISPLAY NAME, which is the one thing two rows of one account can
     * differ in: the buddy list spells someone by their display name and the
     * search-everyone results by whatever the search matched, so re-opening
     * the sheet and picking the same person from the other list seated them
     * twice. Migration 023's unique index refuses that outright now; this is
     * what stops the user ever meeting the refusal. Ghost rows collapse on the
     * name, case-insensitively, for the same reason and by the same rule the
     * notes importer uses.
     *
     * Winning on either row is winning. A row that names nobody is dropped —
     * it would land as a blank line on the scoreboard.
     * @param {DraftShot} shot
     * @returns {Array<{name: string, is_winner: boolean, score: number|null, user_id: string|null}>}
     */
    seats(shot) {
      const out = [];
      const byWho = new Map();
      for (const p of (shot && shot.players) || []) {
        if (!p) continue;
        const name = String(p.name || "").trim();
        if (!p.userId && !name) continue;
        const who = PhotoImport.whoOf({ name, user_id: p.userId || null });
        const taken = byWho.get(who);
        if (taken) {
          taken.is_winner = taken.is_winner || !!p.isWinner;
          // First number wins, so a merge cannot overwrite a score with a
          // blank — same rule the notes importer collapses on.
          if (taken.score == null && (p.score === 0 || p.score)) taken.score = p.score;
          continue;
        }
        const seat = {
          name,
          is_winner: !!p.isWinner,
          score: (p.score === 0 || p.score) ? p.score : null,
          user_id: p.userId || null,
        };
        byWho.set(who, seat);
        out.push(seat);
      }
      return out;
    }

    /**
     * WHO a seat is, with nothing about how this play went — the stable key
     * every seat handler addresses a seat by. Same shape as
     * PlayImport.whoOf(), because the shared review calls one of them without
     * knowing which source it is looking at.
     * @param {{name: string, user_id?: string|null, userId?: string|null}} seat
     */
    static whoOf(seat) {
      const id = seat.user_id || seat.userId || null;
      return id ? `u:${id}` : `g:${String(seat.name || "").trim().toLowerCase()}`;
    }

    /**
     * A shot is importable once it names a game AND seats somebody.
     *
     * The roster half is migration 023's invariant. It used to say "everything
     * else is optional", and a play with nobody at it imported: an empty
     * scoreboard on the card, a play counting towards nobody's record, and no
     * ghost for anyone to claim later. The photo is right there and the seats
     * are two taps, so this is a thing to go and fix rather than a thing to
     * write down.
     *
     * There is no soft-dropped state here, unlike the notes importer: a photo
     * the user doesn't want is removed outright, because it is one thing they
     * are looking straight at rather than one of 58 rows a tally expanded into.
     */
    importable() {
      return this.shots.filter(
        (s) => s.game && s.game.id && this.seats(s).length > 0,
      );
    }

    /** Shots the user kept but never matched to a game. */
    unassigned() {
      return this.shots.filter((s) => !(s.game && s.game.id));
    }

    /**
     * Shots that named a game but seated nobody. Counted apart from
     * `unassigned` because the two have different fixes, and a warning that
     * says how many plays are being left behind without saying which problem
     * to go and solve is not a warning.
     */
    seatless() {
      return this.shots.filter(
        (s) => s.game && s.game.id && this.seats(s).length === 0,
      );
    }

    // ── The shared review adapter ────────────────────────────────────────────
    //
    // The same surface PlayImport exposes, so widgets/import-review-step.js
    // renders both without knowing which it has. What differs is only what
    // genuinely differs: a photo has a thumbnail and a country and is always
    // exactly one play; a note has runs, a bulk date and warnings.

    /** @returns {"notes"|"photos"} */
    get sourceKey() { return "photos"; }

    /** Every photo carries its own date, out of its own EXIF. */
    get supportsBulkDate() { return false; }

    /** Nothing reads a photo, so nothing can flag anything about it. */
    reviewWarnings() { return []; }

    /**
     * The review list, one group per game, one row per shot.
     *
     * Grouped even though a photo is never one of the indistinguishable
     * repeats a note collapses: the grouping is what makes the two sources
     * read as the same screen, and "four photos of Wingspan" is a useful
     * heading on a camera roll from one evening.
     *
     * Unassigned shots get a group of their own rather than being left out —
     * the review is where a user fixes them, so hiding them there would mean
     * the only fix was to walk back to the pager.
     */
    reviewGroups() {
      /** @type {Array<{key: string, name: string, game: any, rows: any[]}>} */
      const out = [];
      const byKey = new Map();
      for (const shot of this.shots) {
        const game = shot.game && shot.game.id ? shot.game : null;
        const k = game ? `id:${game.id}` : "unmatched";
        let group = byKey.get(k);
        if (!group) {
          group = { key: k, name: game ? game.name : "No game yet", game, rows: [] };
          byKey.set(k, group);
          out.push(group);
        }
        group.rows.push(this._reviewRow(shot));
      }
      return out;
    }

    /** @param {DraftShot} shot */
    _reviewRow(shot) {
      return {
        id: shot.id,
        count: 1,
        // One photo is one table. There is nothing here to be a count OF.
        countEditable: false,
        game: shot.game && shot.game.id ? shot.game : null,
        playedAt: shot.playedAt,
        notes: shot.notes || null,
        thumbUrl: shot.url || shot.photoUrl || null,
        countryCode: shot.countryCode || null,
        seats: this.seats(shot),
        // No global mapping to be detached from — every photo's table was
        // always its own.
        edited: false,
        runNote: null,
      };
    }

    /** The third summary tile. Plays and Games are the same for every source. */
    summaryTile() {
      const ready = this.importable();
      const withPhoto = ready.filter((s) => s.file || s.photoUrl).length;
      return {
        label: "Photos",
        value: withPhoto,
        note: withPhoto < ready.length ? `${ready.length - withPhoto} without one` : null,
      };
    }

    /**
     * Why a shot is being left behind. Two reasons, counted apart because they
     * have different fixes.
     */
    reviewNotices() {
      const missing = this.unassigned().length;
      const seatless = this.seatless().length;
      const out = [];
      if (missing) {
        out.push({
          count: missing,
          text: `${missing} photo${missing === 1 ? "" : "s"} still `
              + `${missing === 1 ? "has" : "have"} no game, so `
              + `${missing === 1 ? "it won't" : "they won't"} be imported. `
              + `Match ${missing === 1 ? "it" : "them"} in the review above.`,
        });
      }
      if (seatless) {
        out.push({
          count: seatless,
          text: `${seatless} photo${seatless === 1 ? "" : "s"} `
              + `${seatless === 1 ? "has" : "have"} a game but nobody at the table, `
              + `so ${seatless === 1 ? "it won't" : "they won't"} be imported — a play `
              + `with no players counts towards nobody's record and leaves no ghost `
              + `for anyone to claim. Seat ${seatless === 1 ? "it" : "them"} above.`,
        });
      }
      return out;
    }

    ctaNote() {
      return "The photos go up first, then the plays. Leaving the screen "
           + "mid-run stops it; everything already saved stays saved.";
    }

    /**
     * Two phases behind one bar — `progress.total` is `shots * 2` because an
     * upload and a write are each a step — so the heading says which half is
     * running rather than leaving a bar that stalls at 50% unexplained.
     * @param {any} p @param {boolean} busy
     */
    progressHeading(p, busy) {
      if (!busy) return p && p.failed ? "Import finished" : "Imported";
      // The first half of the bar is photos, the second is plays — worth
      // saying, because the two halves move at very different speeds and a bar
      // that crawls then sprints reads as a bar that is stuck.
      return p && p.done < p.total / 2 ? "Uploading photos…" : "Saving plays…";
    }

    /** @param {any} p */
    progressNote(p) {
      const n = p && p.photosFailed;
      if (!n) return null;
      return `${n} photo${n === 1 ? "" : "s"} didn't upload. `
           + `${n === 1 ? "That play" : "Those plays"} landed without `
           + `${n === 1 ? "it" : "them"} — you can add a photo from the play `
           + `itself later.`;
    }

    // ── Row edits the shared review drives ───────────────────────────────────
    // A row IS a shot here, so these are the per-shot setters under the names
    // the shared review calls them by.

    /** @param {string} id @param {any} game */
    setRowGame(id, game) { this.setGame(id, game); return true; }

    /** @param {string} id @param {string} iso */
    setRowDate(id, iso) { this.setDate(id, iso); return true; }

    /** @param {string} id */
    dropRow(id) { this.removeShot(id); return true; }

    /** Never offered: one photo is one play. @returns {false} */
    setRowCount() { return false; }

    /**
     * One shot as the PlayCreate body the API takes.
     * @param {DraftShot} shot
     * @param {string} batchId
     */
    toPayload(shot, batchId) {
      return {
        game_id: shot.game ? shot.game.id : null,
        played_at: shot.playedAt,
        notes: shot.notes || null,
        photo_url: shot.photoUrl || null,
        // Collapsed — see seats(). One account cannot be seated twice here,
        // which is what migration 023's unique index enforces at the far end.
        players: this.seats(shot),
        country_code: shot.countryCode || null,
        // The idempotency key, stable across attempts by construction.
        client_key: shot.id,
        // Migration 007 — one id for the whole run, so Settings can undo the
        // batch in one tap. No import_group_id: every shot here is one photo
        // of one table, so no two of them are the indistinguishable repeats
        // that field exists to collapse.
        import_batch_id: batchId,
      };
    }

    /**
     * Upload the photos, then write the plays.
     *
     * Photos go first and one at a time. First, because the play row is what
     * carries the URL and a play written without one would need a second
     * request to attach it. One at a time, because thirty parallel multipart
     * uploads on a phone is where the connection — and often the tab — gives
     * up; the progress bar is worth more than the concurrency.
     *
     * A photo that won't upload is not a failed play. The play lands without
     * it and the count is reported at the end: losing the picture is a
     * disappointment, losing the play is the thing the user came for.
     *
     * @param {(p: {done: number, total: number}) => void} [onProgress]
     */
    async run(onProgress) {
      const shots = this.importable();
      const batchId = uid();
      this.progress = {
        done: 0,
        total: shots.length * 2,
        imported: 0,
        duplicate: 0,
        failed: 0,
        photosFailed: 0,
        errors: [],
      };
      const tick = () => { if (onProgress) onProgress(this.progress); };

      for (const shot of shots) {
        // Memoised: a retry after a partial run must not push bytes that
        // already landed, and a restored draft has no file to push at all.
        if (shot.file && !shot.photoUrl) {
          try {
            const fd = new FormData();
            fd.append("file", shot.file);
            const res = await window.api.upload("/plays/photo", fd);
            shot.photoUrl = (res && res.photo_url) || null;
          } catch (_) {
            this.progress.photosFailed++;
          }
        }
        this.progress.done++;
        tick();
      }

      for (let i = 0; i < shots.length; i += CHUNK_SIZE) {
        const chunk = shots.slice(i, i + CHUNK_SIZE);
        const body = { plays: chunk.map((s) => this.toPayload(s, batchId)) };
        let res;
        try {
          res = await window.api.post("/plays/import", body, { timeoutMs: IMPORT_TIMEOUT_MS });
        } catch (_) {
          // One retry — the common failure is a phone on a bad connection, and
          // the client_keys make a repeat free. Past that, stop: every play
          // already written stays written, and running the import again lands
          // only what is missing.
          try {
            res = await window.api.post("/plays/import", body, { timeoutMs: IMPORT_TIMEOUT_MS });
          } catch (err) {
            this.progress.failed += chunk.length;
            this.progress.errors.push((err && err.message) || "Upload failed");
            throw Object.assign(new Error((err && err.message) || "Import failed"), {
              progress: this.progress,
            });
          }
        }
        this.progress.imported += (res && res.imported) || 0;
        this.progress.duplicate += (res && res.duplicate) || 0;
        this.progress.failed += (res && res.failed) || 0;
        for (const r of (res && res.results) || []) {
          if (r && r.error) this.progress.errors.push(r.error);
        }
        this.progress.done += chunk.length;
        tick();
      }
      return this.progress;
    }

    // ── Draft persistence ────────────────────────────────────────────────────

    save() {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: DRAFT_VERSION,
          step: this.step,
          cursor: this.cursor,
          // Everything READ OFF the photos, and nothing of the photos
          // themselves — see the header. `photoUrl` is kept because a shot
          // whose bytes already reached the bucket should not lose them to a
          // refresh, and it is a URL rather than an image.
          shots: this.shots.map((s) => ({
            id: s.id,
            label: s.label,
            playedAt: s.playedAt,
            dateSource: s.dateSource,
            countryCode: s.countryCode,
            countrySource: s.countrySource,
            game: s.game,
            players: s.players,
            notes: s.notes,
            photoUrl: s.photoUrl,
          })),
        }));
      } catch (_) { /* private mode, or full — the draft just isn't resumable */ }
    }

    /** @returns {boolean} whether anything was restored. */
    restore() {
      let saved;
      try {
        saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      } catch (_) {
        return false;
      }
      if (!saved || saved.v !== DRAFT_VERSION || !Array.isArray(saved.shots)) return false;
      if (!saved.shots.length) return false;

      this.releaseFiles();
      this.shots = saved.shots.map((s) => ({
        id: s.id || uid(),
        label: s.label || "",
        file: null,
        url: null,
        playedAt: s.playedAt || todayIso(),
        dateSource: s.dateSource || "user",
        countryCode: s.countryCode || null,
        countrySource: s.countrySource || null,
        game: s.game || null,
        // Normalised seat by seat rather than assigned wholesale, so a draft
        // saved before scores existed restores with the field explicitly
        // absent instead of undefined. That is what lets `score` stay an
        // ADDITIVE change and keeps DRAFT_VERSION where it is — bumping it
        // would throw away every in-flight import on deploy day. Changing the
        // meaning of an existing field would need the bump.
        players: (Array.isArray(s.players) ? s.players : []).map((pl) => ({
          name: pl.name,
          userId: pl.userId || null,
          isWinner: !!pl.isWinner,
          score: (pl.score === 0 || pl.score) ? pl.score : null,
        })),
        notes: s.notes || null,
        photoUrl: s.photoUrl || null,
      }));
      this.photosLost = true;
      this.step = Math.min(Math.max(0, saved.step | 0), STEPS.length - 1);
      // Never resume ON the pick step: its whole job is choosing files, and
      // this draft no longer has any. The assignments are what survived.
      if (this.stepName === "photos") this.step = STEPS.indexOf("assign");
      this.cursor = Math.min(Math.max(0, saved.cursor | 0), this.shots.length - 1);
      this.progress = null;
      return true;
    }

    clearDraft() {
      try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* nothing to clear */ }
    }
  }

  window.PhotoImport = PhotoImport;
})();
