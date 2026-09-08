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

  const STEPS = ["photos", "assign", "import"];

  /**
   * @typedef {Object} DraftSeat
   * @property {string} name      What the play row records.
   * @property {string|null} userId  Set when this seat is a real account.
   * @property {boolean} isWinner
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
     * Take one seat off this table. Removing the last one is legitimate — a
     * play with nobody at it still imports, and the last step says what that
     * costs (it counts towards nobody's record).
     */
    removeSeat(id, name) {
      const s = this.shotFor(id);
      if (!s) return;
      s.players = s.players.filter((p) => p.name !== name);
    }

    /**
     * Toggle who won. Several winners is a tie and a legitimate answer, so
     * this is a toggle rather than a radio — the play flow's Settle Up screen
     * treats it the same way.
     */
    toggleWinner(id, name) {
      const s = this.shotFor(id);
      if (!s) return;
      for (const p of s.players) {
        if (p.name === name) p.isWinner = !p.isWinner;
      }
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
     * A shot is importable once it names a game — everything else is optional.
     *
     * There is no soft-dropped state here, unlike the notes importer: a photo
     * the user doesn't want is removed outright, because it is one thing they
     * are looking straight at rather than one of 58 rows a tally expanded into.
     */
    importable() {
      return this.shots.filter((s) => s.game && s.game.id);
    }

    /** Shots the user kept but never matched to a game. */
    unassigned() {
      return this.shots.filter((s) => !(s.game && s.game.id));
    }

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
        players: shot.players.map((p) => ({
          name: p.name,
          is_winner: !!p.isWinner,
          score: null,
          user_id: p.userId || null,
        })),
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
        players: Array.isArray(s.players) ? s.players : [],
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
