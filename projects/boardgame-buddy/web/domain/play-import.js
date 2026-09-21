// @ts-check
// domain/play-import.js — the play importer's model.
//
// Owns the draft: what was pasted, what the model made of it, how each name
// and each game resolved, and the chunked write at the end. No DOM — the view
// (views/import-wizard-view.js) reads this and paints, and the step bodies
// (the per-source widgets/import-*-steps.js) are pure functions of it.
//
// Three things here are worth knowing before reading the view:
//
//   • THE PARSE IS EXPANDED ONCE. The server answers with runs ("Sean won 58
//     of these"), because a 106-play tally written out play by play is a reply
//     the model loses count of. expand() turns each run into individual draft
//     plays the moment the parse lands, so every screen after that — the
//     review list, the counts, the write — deals in plays, not in runs. The
//     run survives only as `runId`, which by the review step is no longer what
//     collapses the list (see rows()) — only what lets the row's detail panel
//     say where its repeats came from.
//
//   • EVERY DRAFT PLAY CARRIES ITS OWN client_key. Stamped at expansion, kept
//     in the saved draft, sent on every attempt. bgb_log_play answers a key it
//     already holds with {duplicate: true}, so re-running a half-finished
//     import lands the rest and re-writes nothing.
//
//   • THE SEATS ARE RESOLVED IN ONE PLACE — seats(). `play.players` stays the
//     note as the model parsed it; what gets written, what the review list
//     draws, and what the row and group keys are built from all come from
//     seats(), which maps each name through the Players step and COLLAPSES two
//     names that turned out to be one person. The Players step promises that in
//     as many words; the write used not to keep the promise, which is how a
//     note saying "Jas" and "Jasmine" imported a game with Jasmine in it twice.
//
//   • GROUPING HAPPENS AFTER THE ASSIGNMENTS, NEVER BEFORE. What collapses the
//     review list is `rowKeyFor`: the CATALOG game, the day, the note, and the
//     seats as the user resolved them (an account id wherever there is one).
//     The parse cannot know that "Jas" and "Jasmine" are one buddy — by the
//     review step the user has said so, and a list keyed on how the note wrote
//     them would be showing the user their own note back rather than the plays
//     they are about to import. `import_group_id` is that same identity at
//     write time (groupKeyFor), minus the plays with something of their own to
//     say: a score or a note disqualifies a play from the feed's group however
//     the model counted it, because the group's card cannot say it.
//
//   • THE DRAFT IS SAVED, NOT THE PARSE. localStorage holds the whole draft
//     under a versioned key. A refresh three steps in resumes where it was; a
//     build that changes the shape bumps DRAFT_VERSION and drops what it can
//     no longer read, rather than half-restoring it.

(function () {
  const DRAFT_KEY = "bgb.playImport.draft";
  // Bump when the draft shape changes. A stored draft at a different version
  // is discarded — a half-understood resume is worse than starting over.
  const DRAFT_VERSION = 1;

  // Mirrors IMPORT_CHUNK_MAX in shared-backend/routes/boardgame_buddy/constants.py.
  const CHUNK_SIZE = 50;
  // Mirrors MAX_IMPORT_CHARS.
  const MAX_CHARS = 20000;
  // Mirrors MAX_IMPORT_HINT_CHARS.
  const MAX_HINT_CHARS = 1000;
  // Mirrors MAX_IMPORT_IMAGES. A notebook page photographs as one image and a
  // spread as two, so four covers a double spread or a long list shot in
  // sections — and past that the model is being asked to hold more page than
  // it reads reliably in one pass.
  const MAX_PHOTOS = 4;
  // Mirrors MAX_REPEAT_COUNT — the ceiling the parser already clamps a run to,
  // so hand-editing one cannot get past what the model was allowed to say.
  const MAX_RUN = 300;
  // The parse walks a whole note through a model; 15s is a JSON round trip.
  const PARSE_TIMEOUT_MS = 90000;
  const IMPORT_TIMEOUT_MS = 60000;

  // The wizard's step list for this source, the source picker aside. The
  // review step used to be called "plays" — it is `review` now because it is
  // the same screen the photo branch ends on (widgets/import-review-step.js),
  // and two names for one screen is how two screens start.
  const STEPS = ["source", "details", "players", "games", "review", "import"];

  /**
   * @typedef {Object} DraftPlayer
   * @property {string} name       As the note wrote it. The mapping key.
   * @property {boolean} isWinner
   * @property {number|null} score
   */

  /**
   * @typedef {Object} DraftPlay
   * @property {string} id         Local id — also the client_key sent to the API.
   * @property {string} gameName   As the note wrote it. Keys into `games`.
   * @property {string|null} gameId  Per-play override; falls back to the mapping.
   * @property {string|null} playedAt  ISO date, or null for "use the default".
   * @property {string|null} notes
   * @property {DraftPlayer[]} players
   * @property {string|null} runId  Set when this play came out of a `count`
   *   run. Identical plays share one, which is what the review list collapses.
   * @property {Array<{name: string, is_winner: boolean, score: number|null,
   *   user_id: string|null}>|null} [seatsOverride]  This table, exactly — set
   *   the first time the user edits the seats of this play, after which it no
   *   longer follows the global Players mapping. Null on every play the user
   *   has not touched, which is nearly all of them. See _materialise().
   * @property {boolean} dropped   Kept rather than spliced, so undo is possible
   *   and a run's counts stay stable while the user trims it.
   */

  /**
   * @typedef {Object} DraftPhoto
   * @property {string} id     Local, for the remove control.
   * @property {string} mime   image/jpeg | image/png | image/webp.
   * @property {string} data   Bare base64, no `data:` prefix.
   * @property {string} url    Object URL for the thumbnail. Revoked on removal.
   * @property {number} bytes  Compressed size, for the "N photos, 1.2 MB" line.
   */

  /**
   * @typedef {Object} NameMapping
   * @property {"buddy"|"ghost"} kind
   * @property {string|null} userId   Set for kind "buddy".
   * @property {string} label         What the review list shows.
   */

  const uid = () => (
    (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      // Older WebKit. Only has to be unique per draft — the server treats it
      // as an opaque idempotency key, and a collision across two drafts would
      // need the same 32 hex digits twice.
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
      })
  );

  const key = (s) => String(s || "").trim().toLowerCase();
  const todayIso = () => {
    // Local date, not toISOString() — that is UTC, so an evening play in a
    // western timezone would import as tomorrow.
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  class PlayImport {
    constructor() { this.reset(); }

    reset() {
      this.step = 0;
      this.text = "";
      this.hint = "";
      this.clearPhotos();
      /** @type {DraftPhoto[]} Photographs of the note, in page order. */
      this.photos = [];
      /** @type {DraftPlay[]} */
      this.plays = [];
      /** @type {string[]} Distinct player names, first-seen order. */
      this.playerNames = [];
      /** @type {Object<string, NameMapping>} keyed by lowercased name. */
      this.playerMap = {};
      /** @type {Array<{name: string, candidates: any[], confident: boolean}>} */
      this.gameRefs = [];
      /** @type {Object<string, {id: string, name: string, thumbnail_url: string|null}|null>} */
      this.gameMap = {};
      /** @type {string[]} */
      this.warnings = [];
      // The bulk date from the Plays step. Null = each play keeps its own
      // parsed date, or today when it hasn't got one.
      this.bulkDate = null;
      /** @type {{done: number, total: number, imported: number, duplicate: number, failed: number, errors: string[]}|null} */
      this.progress = null;
    }

    get stepName() { return STEPS[this.step] || STEPS[0]; }
    static get steps() { return STEPS.slice(); }
    static get maxChars() { return MAX_CHARS; }
    static get maxHintChars() { return MAX_HINT_CHARS; }
    static get maxPhotos() { return MAX_PHOTOS; }

    // ── Parse ────────────────────────────────────────────────────────────────

    /** Send the note. Replaces every downstream field — a re-parse starts over. */
    // ── Photographs of the note ──────────────────────────────────────────────
    //
    // Held in memory and NEVER in the saved draft: four pages of base64 is a
    // couple of megabytes against a localStorage quota of five, so persisting
    // them would trade a resume the user rarely needs for the save that keeps
    // their whole reviewed import. save() writes an explicit field list, so
    // this is enforced by that list rather than by a rule someone has to
    // remember — but the source step still says so, because a refresh mid-
    // wizard is otherwise an empty box with no explanation.

    /** @param {DraftPhoto} photo */
    addPhoto(photo) {
      if (this.photos.length >= MAX_PHOTOS) return false;
      this.photos.push(photo);
      return true;
    }

    /** @param {string} id */
    removePhoto(id) {
      const i = this.photos.findIndex((p) => p.id === id);
      if (i < 0) return;
      const [gone] = this.photos.splice(i, 1);
      // The object URL outlives the <img> that held it, so dropping the array
      // entry alone leaks the blob for the life of the document.
      if (gone && gone.url) { try { URL.revokeObjectURL(gone.url); } catch (_) {} }
    }

    clearPhotos() {
      for (const p of this.photos || []) {
        if (p && p.url) { try { URL.revokeObjectURL(p.url); } catch (_) {} }
      }
      this.photos = [];
    }

    /** Room left, so the picker can say how many more it will take. */
    get photoRoom() { return Math.max(0, MAX_PHOTOS - this.photos.length); }

    async parse() {
      const res = await window.api.post(
        "/plays/import/parse",
        {
          text: this.text.slice(0, MAX_CHARS),
          hint: this.hint.trim().slice(0, MAX_HINT_CHARS) || null,
          // Page order is the order they were added, which is the order the
          // prompt tells the model to read them in.
          images: this.photos.map((p) => ({ mime_type: p.mime, data: p.data })),
        },
        { timeoutMs: PARSE_TIMEOUT_MS },
      );
      this.plays = PlayImport.expand(res && res.plays);
      this.playerNames = (res && res.players) || [];
      this.gameRefs = (res && res.games) || [];
      this.warnings = (res && res.warnings) || [];
      this.playerMap = {};
      this.gameMap = {};
      this.bulkDate = null;
      this.progress = null;
      this._seedGameMap();
      return this;
    }

    /**
     * Runs → individual draft plays, in the order the note gave them.
     * @param {any[]} parsed
     * @returns {DraftPlay[]}
     */
    static expand(parsed) {
      /** @type {DraftPlay[]} */
      const out = [];
      for (const p of parsed || []) {
        const count = Math.max(1, Number(p.count) || 1);
        // A run of one is not a run: giving it a runId would make the review
        // list collapse a single play behind a "1 play" disclosure.
        const runId = count > 1 ? uid() : null;
        const players = (p.players || []).map((pl) => ({
          name: String(pl.name || ""),
          isWinner: !!pl.is_winner,
          score: (pl.score === 0 || pl.score) ? Number(pl.score) : null,
        }));
        for (let i = 0; i < count; i++) {
          out.push({
            id: uid(),
            gameName: String(p.game || ""),
            gameId: null,
            playedAt: p.played_at || null,
            notes: p.notes || null,
            // Deep copy per play: the review list edits one repeat's scores
            // without touching the other fifty-seven.
            players: players.map((pl) => ({ ...pl })),
            runId,
            dropped: false,
          });
        }
      }
      return out;
    }

    /** Pre-select the games the server matched confidently. */
    _seedGameMap() {
      for (const ref of this.gameRefs) {
        const first = (ref.candidates || [])[0];
        if (ref.confident && first) {
          this.gameMap[key(ref.name)] = {
            id: first.id, name: first.name, thumbnail_url: first.thumbnail_url || null,
          };
        } else if (!(key(ref.name) in this.gameMap)) {
          this.gameMap[key(ref.name)] = null;
        }
      }
    }

    // ── Player mapping ───────────────────────────────────────────────────────

    /**
     * Auto-suggest a mapping for every unmapped name against the viewer's
     * play partners — their buddies, everyone they've shared a table with, and
     * their own ghost players — scored by domain/name-match.js. Only matches
     * clearing MIN_AUTO (an exact name, a first name, or a genuine shortening
     * like "Jas" → "Jasmine") are applied; anything weaker is left for the
     * picker sheet to offer, ranked by the same score. Never applied to a name
     * the user has already decided about.
     *
     * Matching runs over the display name AND the username, in that order, so
     * a note that writes "@marcus" finds Marcus Chen — and a display-name
     * match wins a tie against a username one.
     *
     * @param {{accounts?: any[], ghosts?: any[], recent?: any[]}|null} partners
     */
    suggestPlayers(partners) {
      const people = PlayImport.candidates(partners);
      const accounts = people.filter((c) => c.user_id);
      const ghosts = people.filter((c) => !c.user_id);
      // The viewer is checked FIRST and separately, because /play-partners
      // never returns them: a note that records your own name should map to
      // your account without a tap, and getting that wrong is the difference
      // between an import counting toward your win record and toward a ghost's.
      const me = (window.store && window.store.get && window.store.get("user")) || null;
      const meRow = me
        ? [{ user_id: me.id, name: me.display_name || me.username || "", username: me.username || null }]
        : [];
      for (const name of this.playerNames) {
        const k = key(name);
        if (this.playerMap[k]) continue;
        const self = PlayImport._bestMatch(name, meRow);
        if (self) {
          this.playerMap[k] = { kind: "buddy", userId: self.user_id, label: self.name || name };
          continue;
        }
        const account = PlayImport._bestMatch(name, accounts);
        if (account) {
          this.playerMap[k] = { kind: "buddy", userId: account.user_id, label: account.name || name };
          continue;
        }
        const ghost = PlayImport._bestMatch(name, ghosts);
        this.playerMap[k] = {
          kind: "ghost",
          userId: null,
          // Matching an existing ghost adopts ITS spelling, so the import
          // lands on the same player rather than creating a near-duplicate.
          label: ghost ? (ghost.name || name) : name,
        };
      }
    }

    /**
     * The viewer's partners as picker candidates. One mapping, in
     * domain/buddy.js, shared with the sheet the Players step opens — the two
     * disagreeing is what produced a "Jas → ghost" row sitting above a picker
     * that had Jasmine in it all along.
     * @param {{accounts?: any[], ghosts?: any[], recent?: any[]}|null} partners
     */
    static candidates(partners) {
      return (window.Buddy && window.Buddy.toPlayerCandidates)
        ? window.Buddy.toPlayerCandidates(partners)
        : [];
    }

    /** The names a candidate can be recognised by, best evidence first. */
    static namesOf(candidate) {
      return [candidate.name, candidate.username];
    }

    /**
     * Confident enough to apply without asking. Below this bar the picker
     * still offers the row — see MIN_SUGGEST in domain/name-match.js.
     */
    static _bestMatch(name, rows) {
      return window.BgbNameMatch.best(name, rows || [], PlayImport.namesOf);
    }

    /** @param {string} name @param {NameMapping} mapping */
    setPlayer(name, mapping) { this.playerMap[key(name)] = mapping; }

    /** @param {string} name */
    playerMapping(name) {
      return this.playerMap[key(name)] || { kind: "ghost", userId: null, label: name };
    }

    // ── Game mapping ─────────────────────────────────────────────────────────

    /** @param {string} gameName @param {any|null} game */
    setGame(gameName, game) {
      this.gameMap[key(gameName)] = game
        ? { id: game.id, name: game.name, thumbnail_url: game.thumbnail_url || null }
        : null;
    }

    /** @param {string} gameName */
    gameMapping(gameName) { return this.gameMap[key(gameName)] || null; }

    /** Resolved game for one play — its own override, else the mapping. */
    playGame(play) {
      if (play.gameId) {
        for (const g of Object.values(this.gameMap)) {
          if (g && g.id === play.gameId) return g;
        }
        return { id: play.gameId, name: play.gameName, thumbnail_url: null };
      }
      return this.gameMapping(play.gameName);
    }

    /** Game names still unresolved, and how many live plays each costs. */
    unresolvedGames() {
      const counts = {};
      for (const p of this.plays) {
        if (p.dropped || p.gameId) continue;
        const k = key(p.gameName);
        if (this.gameMap[k]) continue;
        counts[k] = counts[k] || { name: p.gameName, plays: 0 };
        counts[k].plays++;
      }
      return Object.values(counts);
    }

    // ── The review list ──────────────────────────────────────────────────────

    /** Live plays, grouped into the review list's per-game subsections. */
    groups() {
      /** @type {Array<{key: string, name: string, game: any, plays: DraftPlay[]}>} */
      const out = [];
      const byKey = new Map();
      for (const play of this.plays) {
        if (play.dropped) continue;
        const game = this.playGame(play);
        const k = game ? `id:${game.id}` : `name:${key(play.gameName)}`;
        let group = byKey.get(k);
        if (!group) {
          group = { key: k, name: game ? game.name : play.gameName, game, plays: [] };
          byKey.set(k, group);
          out.push(group);
        }
        group.plays.push(play);
      }
      return out;
    }

    /**
     * One group's plays as review rows: everything indistinguishable collapses
     * into a single row carrying all of it.
     *
     * KEYED ON WHAT THE PLAY RESOLVED TO, not on how the note wrote it. A note
     * that says "Jas" in one line and "Jasmine" in another wrote two entries,
     * and the parse has no way to know they are one person — but by this step
     * the user has said so on the Players screen, and a review list that still
     * shows them as two different people is showing the user their own note
     * back rather than the plays they are about to import. Same for two
     * spellings of a game matched to one catalog entry.
     *
     * This is the same identity `groupKeyFor` uses for the feed, so the row
     * the user reviews and the card the feed will show cannot disagree.
     *
     * Rows appear where their FIRST play does, so a run and the plays around
     * it stay where the note put them, and a late duplicate joins the row it
     * matches rather than opening a second one further down.
     * @param {DraftPlay[]} plays
     * @returns {Array<{key: string, runId: string|null, plays: DraftPlay[]}>}
     */
    rows(plays) {
      /** @type {Array<{key: string, runId: string|null, plays: DraftPlay[]}>} */
      const out = [];
      const byKey = new Map();
      for (const play of plays || []) {
        const k = this.rowKeyFor(play);
        let row = byKey.get(k);
        if (!row) {
          row = { key: k, runId: play.runId || null, plays: [] };
          byKey.set(k, row);
          out.push(row);
        } else if (row.runId !== (play.runId || null)) {
          // Mixed provenance: a run plus a separately-written play that turned
          // out identical. The row is still one row, but it is no longer "the
          // model's tally", and the detail panel says so.
          row.runId = null;
        }
        row.plays.push(play);
      }
      return out;
    }

    /**
     * What a reader would use to tell two plays apart, after everything the
     * user has resolved: the catalog game, the day, the note, and who was
     * there with what score. Seats are sorted, so seating order is not part of
     * the identity — the same people in a different order are the same play.
     * @param {DraftPlay} play
     */
    rowKeyFor(play) {
      const game = this.playGame(play);
      const seats = this.seats(play).map((s) => this.seatKey(s)).sort();
      return [
        game ? `id:${game.id}` : `name:${key(play.gameName)}`,
        this.dateFor(play),
        play.notes || "",
        seats.join(","),
      ].join("|");
    }

    /**
     * THE SEATS OF ONE PLAY, AS THEY WILL BE WRITTEN — resolved through the
     * Players step and collapsed wherever two of the note's names turned out
     * to be one person.
     *
     * The collapse is the whole reason this exists. The Players step's own
     * help text promises it ("point them at the same buddy, or give them the
     * same ghost name, and they'll land as one player"), and the review list
     * has always honoured it, because rowKeyFor keys a seat on the ACCOUNT
     * rather than on the spelling. The WRITE did not: it emitted one seat per
     * name, so a note that said "Jas" on one line and "Jasmine" on the next
     * imported a two-player game with Jasmine in it twice — once winning, once
     * not. Migration 023's unique index now refuses that outright; this is what
     * stops the user ever meeting the refusal.
     *
     * Merging a seat into one already taken keeps the fuller answer: winning on
     * either spelling is winning, and the first score anybody wrote down is the
     * score. A seat that names nobody at all is dropped rather than merged —
     * the model can emit one from an unreadable line, and it would land as a
     * blank row on the scoreboard.
     *
     * Everything downstream reads THIS, not play.players: the payload, the
     * review row's identity, the feed group, and what the detail panel draws.
     * play.players stays the note as parsed, which is what the mapping is for.
     * @param {DraftPlay} play
     * @returns {Array<{name: string, is_winner: boolean, score: number|null, user_id: string|null}>}
     */
    seats(play) {
      // An edited table answers for itself. See _materialise(): once the user
      // has changed the seats of one play, the global Players mapping is no
      // longer the truth about THAT play, and re-deriving through it would
      // silently undo what they just did.
      if (play && play.seatsOverride) return this._collapse(play.seatsOverride);
      return this._collapse(
        ((play && play.players) || []).map((pl) => {
          const m = this.playerMapping(pl.name);
          return {
            name: m.label || pl.name,
            is_winner: !!pl.isWinner,
            score: (pl.score === 0 || pl.score) ? pl.score : null,
            user_id: m.userId || null,
          };
        }));
    }

    /**
     * Merge seats that are the same person, whatever they were called.
     *
     * The collapse point for migration 023's uq_bgb_play_players_play_user:
     * the Players step exists to say that "Jas" and "Jasmine" are one person,
     * and the write has to honour that or the server refuses the play. Seats
     * added by hand in the review go through the same merge, so picking
     * somebody already at the table cannot seat them twice.
     *
     * The winner flag ORs and the first non-null score wins — a merge must not
     * lose a win, and it must not overwrite a number with a blank.
     *
     * A seat that names nobody at all is dropped rather than merged: the model
     * can emit one from an unreadable line, and it would land as a blank row
     * on the scoreboard.
     * @param {Array<{name: string, is_winner: boolean, score: number|null, user_id: string|null}>} seats
     */
    _collapse(seats) {
      const out = [];
      const byWho = new Map();
      for (const seat of seats || []) {
        if (!seat) continue;
        const label = seat.name;
        if (!seat.user_id && !key(label)) continue;
        const who = PlayImport.whoOf(seat);
        const taken = byWho.get(who);
        if (taken) {
          taken.is_winner = taken.is_winner || !!seat.is_winner;
          if (taken.score == null && (seat.score === 0 || seat.score)) taken.score = seat.score;
          continue;
        }
        const next = {
          name: label,
          is_winner: !!seat.is_winner,
          score: (seat.score === 0 || seat.score) ? seat.score : null,
          user_id: seat.user_id || null,
        };
        byWho.set(who, next);
        out.push(next);
      }
      return out;
    }

    /**
     * WHO a seat is, with nothing about how this play went.
     *
     * seatKey() below is the row identity and so carries the win and the
     * score, which means it changes the moment either is edited — it cannot
     * address a seat across the edit that changes it. This can: it is the
     * stable half, and it is what every seat handler takes.
     * @param {{name: string, user_id: string|null}} seat
     */
    static whoOf(seat) {
      return seat.user_id ? `u:${seat.user_id}` : `g:${key(seat.name)}`;
    }

    /**
     * One written seat's identity, for the row and group keys. The ACCOUNT
     * when the name resolved to one; the resolved ghost label otherwise. Never
     * the name the note wrote — that is the thing the Players step exists to
     * translate.
     * @param {{name: string, is_winner: boolean, score: number|null, user_id: string|null}} seat
     */
    seatKey(seat) {
      return `${PlayImport.whoOf(seat)}#${seat.is_winner ? "w" : ""}`
           + `#${seat.score == null ? "" : seat.score}`;
    }

    /**
     * The review row a play belongs to. Rows are derived, so this recomputes
     * them rather than holding an index that a re-assignment would stale.
     * @param {string} playId
     */
    rowFor(playId) {
      for (const group of this.groups()) {
        for (const row of this.rows(group.plays)) {
          if (row.plays.some((p) => p.id === playId)) return row;
        }
      }
      return null;
    }

    /** @param {DraftPlay} play */
    dateFor(play) { return play.playedAt || this.bulkDate || todayIso(); }

    /** True when the note gave no date for a single play. */
    static get today() { return todayIso(); }

    get liveCount() { return this.plays.filter((p) => !p.dropped).length; }

    /**
     * Plays that will actually be written — live, with a resolved game, and
     * with somebody at the table.
     *
     * The roster clause is migration 023's invariant, checked here so the user
     * meets it as a row the Import step counts out rather than as a play the
     * server refuses. A note the model read a game and a date off but no names
     * at all — a bare tally, a line it couldn't parse — used to import as a
     * play with an empty scoreboard, counting towards nobody's record and
     * leaving no ghost anyone could ever claim.
     */
    importable() {
      return this.plays.filter(
        (p) => !p.dropped && !!this.playGame(p) && this.seats(p).length > 0,
      );
    }

    /**
     * Live plays whose game resolved but whose table is empty — what the
     * Import step names as the second reason a play is being left behind.
     * Counted separately from the unmatched-game plays because the two have
     * different fixes, and "12 plays won't import" without saying which
     * problem to go and solve is not a warning.
     */
    seatless() {
      return this.plays.filter(
        (p) => !p.dropped && !!this.playGame(p) && this.seats(p).length === 0,
      );
    }

    /**
     * Resize a row — the tally said 58 and it was really 44.
     *
     * Sized off the ROW, not the run: by this step a row can hold a run PLUS a
     * separately-written play that resolved to the same thing, and the control
     * sits under a heading that counts the row. Resizing anything narrower
     * would answer a different number from the one on screen.
     *
     * Grows by cloning the row's first play (a fresh id, which IS the
     * client_key, so an added play is a new play and not a duplicate of one
     * already sent) and shrinks by dropping from the tail. Insertions land
     * beside the row rather than at the end of the draft, so the review list
     * does not reorder under the reader while they are typing in it.
     *
     * Only offered before the import, and only on a row that already holds
     * more than one play: after the import the plays are rows, and conjuring
     * plays out of a single one is a different and much more dangerous act.
     *
     * @param {string} playId  Any play in the row (the row's first).
     * @param {number} next    Desired size, clamped to [1, MAX_RUN].
     */
    setRowCount(playId, next) {
      const row = this.rowFor(playId);
      if (!row || row.plays.length < 2) return;
      const want = Math.max(1, Math.min(MAX_RUN, Math.floor(Number(next) || 1)));
      const have = row.plays.length;
      if (want === have) return;

      if (want < have) {
        // Drop rather than splice, so the same undo path as the trash control
        // applies and a mis-typed number is recoverable by typing another.
        this.dropPlays(row.plays.slice(want).map((p) => p.id));
        return;
      }
      const seed = row.plays[0];
      const at = this.plays.indexOf(row.plays[row.plays.length - 1]) + 1;
      const added = [];
      for (let i = 0; i < want - have; i++) {
        // Spread, so a clone keeps the seed's runId: growing a row that IS a
        // run keeps it one run rather than splitting it in two.
        added.push({
          ...seed,
          id: uid(),
          players: seed.players.map((pl) => ({ ...pl })),
          dropped: false,
        });
      }
      this.plays.splice(at, 0, ...added);
    }

    dropPlays(ids) {
      const set = new Set(ids);
      for (const p of this.plays) if (set.has(p.id)) p.dropped = true;
    }

    // ── The shared review adapter ────────────────────────────────────────────
    //
    // widgets/import-review-step.js renders every source through this surface,
    // so the review and the summary are one screen rather than two that look
    // alike. What is source-specific is the handful of values below — a photo
    // has a thumbnail and a country and no run to collapse; a note has a bulk
    // date, warnings the model raised, and runs. The SHAPE is identical, which
    // is the whole point.

    /** @returns {"notes"|"photos"|"bga"} */
    get sourceKey() { return "notes"; }

    /**
     * The catalog game of one item in `importable()`.
     *
     * Part of the ImportSource interface so the shared summary can ask every
     * model the same question — a note's play resolves through the game map, a
     * photo carries its game on the shot, and the step must not have to know
     * which.
     * @param {DraftPlay} play
     */
    gameOf(play) { return this.playGame(play); }

    /** A note can leave a play undated; every photo carries its own date. */
    get supportsBulkDate() { return true; }

    /** The picker's Resume row, in this source's own words. */
    resumeLabel() {
      const n = this.liveCount;
      return `A note with ${n} play${n === 1 ? "" : "s"} read out of it`;
    }

    /** Things the model flagged while reading. Nothing else raises any. */
    reviewWarnings() { return this.warnings || []; }

    /**
     * The review list: live plays, per catalog game, each group's plays
     * collapsed into rows. `rows` is the only shape the shared step renders.
     */
    reviewGroups() {
      return this.groups().map((group) => ({
        key: group.key,
        name: group.name,
        game: group.game,
        rows: this.rows(group.plays).map((row) => this._reviewRow(row)),
      }));
    }

    /** @param {{key: string, runId: string|null, plays: DraftPlay[]}} row */
    _reviewRow(row) {
      const first = row.plays[0];
      const n = row.plays.length;
      return {
        id: first.id,
        count: n,
        // A note is the one source where several plays can be one row, so it
        // is the one source where the count is a control.
        countEditable: n > 1,
        game: this.playGame(first),
        playedAt: this.dateFor(first),
        notes: first.notes || null,
        thumbUrl: null,
        countryCode: null,
        seats: this.seats(first),
        edited: !!first.seatsOverride,
        runNote: n > 1
          ? (row.runId
            ? `they came from one run of repeats in your notes.`
            : `your notes wrote them as separate entries that came out identical `
              + `— same game, same day, same players.`)
          : null,
      };
    }

    /** The third summary tile. Plays and Games are the same for every source. */
    summaryTile() {
      const buddies = this.playerNames
        .filter((n) => this.playerMapping(n).kind === "buddy").length;
      const ghosts = this.playerNames.length - buddies;
      return {
        label: "Players",
        value: buddies + ghosts,
        note: `${buddies} ${buddies === 1 ? "buddy" : "buddies"} · `
            + `${ghosts} ghost${ghosts === 1 ? "" : "s"}`,
      };
    }

    /**
     * Why a live play is being left behind, counted apart because the two have
     * different fixes — one is a step back to Games, the other is a line the
     * note never named anybody on. "12 plays won't import" without saying
     * which problem to go and solve is not a warning.
     */
    reviewNotices() {
      const seatless = this.seatless().length;
      const gameless = this.liveCount - this.importable().length - seatless;
      const out = [];
      if (gameless) {
        out.push({
          count: gameless,
          text: `${gameless} play${gameless === 1 ? "" : "s"} won't be imported — `
              + `no game matched. Go back to Games to match `
              + `${gameless === 1 ? "it" : "them"}.`,
        });
      }
      if (seatless) {
        out.push({
          count: seatless,
          text: `${seatless} play${seatless === 1 ? "" : "s"} won't be imported — `
              + `nobody at the table. A play needs at least one player, or it counts `
              + `towards nobody's record and no ghost can ever claim it. Go back to `
              + `the review to check ${seatless === 1 ? "it" : "them"}.`,
        });
      }
      return out;
    }

    /** A line under the CTA. The note importer has nothing to add. */
    ctaNote() { return null; }

    /** @param {any} p @param {boolean} busy */
    progressHeading(p, busy) {
      return busy ? "Importing…" : (p && p.failed ? "Import finished" : "Imported");
    }

    progressNote() { return null; }

    // ── Row edits the shared review drives ───────────────────────────────────

    /** @param {string} playId @param {any} game */
    setRowGame(playId, game) {
      const row = this.rowFor(playId);
      if (!row || !game) return false;
      for (const play of row.plays) play.gameId = game.id;
      // The global mapping too: the row said what this game name means, and
      // leaving the Games step disagreeing with the row is how a later edit
      // silently reverts this one.
      this.setGame(game.name, game);
      return true;
    }

    /** @param {string} playId @param {string} iso */
    setRowDate(playId, iso) {
      const row = this.rowFor(playId);
      if (!row) return false;
      for (const play of row.plays) play.playedAt = iso || null;
      return true;
    }

    /** @param {string} playId */
    dropRow(playId) {
      const row = this.rowFor(playId);
      if (!row) return false;
      this.dropPlays(row.plays.map((p) => p.id));
      return true;
    }

    // ── Per-play seat editing ────────────────────────────────────────────────
    //
    // Every edit below applies to the WHOLE ROW, which is the established
    // semantics of this screen — setRowDate and the per-row game override
    // already loop the row, and the detail panel already says "editing
    // anything else here changes all N". An identical change to N plays
    // produces N identical new keys, so the row survives as one row of N.
    //
    // Two consequences worth knowing rather than discovering:
    //   • Two rows can MERGE, when an edit makes their keys equal. That is
    //     correct — they are now indistinguishable — and is already what the
    //     per-row game override does. The caller has to re-resolve its open-row
    //     anchor afterwards, because a merge orphans one of the two ids.
    //   • groupKeyFor IS rowKeyFor, so these also move feed grouping. Also
    //     already true of a date or a game edit, and intended: the row the user
    //     reviewed and the card the feed shows must not disagree.

    /**
     * Detach a play's table from the global Players mapping, seeding it with
     * what that mapping currently says.
     *
     * Seats are DERIVED — `seats()` runs play.players through this.playerMap —
     * and that map is one entry per name across the whole note. So taking Sean
     * off one play by editing the map would take him off every play, and
     * editing play.players would edit the note as parsed, which is the thing
     * the mapping exists to translate. The override is a third layer: it says
     * "this table, exactly", and from here the play no longer follows the
     * Players step. The review row says so where the user can see it.
     * @param {DraftPlay} play
     */
    _materialise(play) {
      if (!play.seatsOverride) play.seatsOverride = this.seats(play);
      return play.seatsOverride;
    }

    /**
     * Apply one edit to every play in a row.
     * @param {string} playId Any play in the row (the row's anchor).
     * @param {(seats: any[]) => any[]|void} fn
     */
    _editRow(playId, fn) {
      const row = this.rowFor(playId);
      if (!row) return false;
      for (const play of row.plays) {
        const next = fn(this._materialise(play).map((s) => ({ ...s })));
        if (next) play.seatsOverride = next;
      }
      return true;
    }

    /** @param {string} playId @param {any[]} picks PlayerCandidate rows. */
    addSeats(playId, picks) {
      if (!picks || !picks.length) return false;
      return this._editRow(playId, (seats) => seats.concat(picks.map((pick) => ({
        name: pick.name,
        is_winner: false,
        score: null,
        user_id: pick.user_id || null,
      }))));
    }

    /** @param {string} playId @param {string} who A whoOf() key. */
    removeSeat(playId, who) {
      return this._editRow(playId,
        (seats) => seats.filter((s) => PlayImport.whoOf(s) !== who));
    }

    /**
     * Several winners is a tie, so this toggles one seat rather than moving a
     * single crown — the same contract the photo importer's seat toggle has.
     * @param {string} playId @param {string} who A whoOf() key.
     */
    toggleWinner(playId, who) {
      return this._editRow(playId, (seats) => seats.map((s) => (
        PlayImport.whoOf(s) === who ? { ...s, is_winner: !s.is_winner } : s
      )));
    }

    /**
     * One final score for one seat. Blank clears it back to null rather than
     * writing 0 — a game nobody recorded a score for is not a game everybody
     * scored nothing in.
     *
     * The caller must not offer this on a row standing for more than one play:
     * fifty-eight plays that all scored 112 is not a thing that happened, and
     * this would write it to all of them.
     * @param {string} playId @param {string} who @param {string|number} value
     */
    setScore(playId, who, value) {
      const raw = String(value == null ? "" : value).trim();
      const score = raw === "" ? null : Math.trunc(Number(raw));
      if (score != null && !Number.isFinite(score)) return false;
      return this._editRow(playId, (seats) => seats.map((s) => (
        PlayImport.whoOf(s) === who ? { ...s, score } : s
      )));
    }

    // ── The write ────────────────────────────────────────────────────────────

    /**
     * The identity of a play for FEED grouping, or null when it cannot be
     * grouped at all.
     *
     * THE ROW IDENTITY, WHOLE. It used to disqualify any play carrying a note
     * or a score, on the reasoning that those are the plays a reader wants to
     * see individually — the biggest win, the closest game, the one with a
     * comment. That reasoning is about a play that DIFFERS from its
     * neighbours, and the identity key is already the test for that: a play
     * with a note or a score nobody else in the import shares is alone at its
     * key, and assignGroups only mints an id for a key covering more than one
     * play, so it gets its own card either way.
     *
     * What the disqualifiers actually caught was the opposite case — plays
     * that are identical INCLUDING their note or their score, which is exactly
     * what a stack is for. A nineteen-play run whose entry carried "league
     * night" imported as nineteen separate cards, while the review list, which
     * keys on rowKeyFor, had shown it as one row of nineteen. The two surfaces
     * disagreeing is the bug; sharing one key is the fix.
     *
     * Deliberately NOT play.runId. The run id says "the model wrote these as
     * one line"; this says "these are indistinguishable". The second is the
     * claim the collapsed card actually makes, and it survives the model
     * splitting a run across entries or lumping a scored play into one.
     * @param {DraftPlay} play
     * @returns {string|null}
     */
    groupKeyFor(play) {
      // The one genuine disqualifier: a play with no catalog game is not
      // importable, so it has nothing to be grouped with.
      if (!this.playGame(play)) return null;
      return this.rowKeyFor(play);
    }

    /**
     * Mint one group id per key that covers MORE THAN ONE play, and hand back
     * a play-id → group-id map.
     *
     * The "more than one" is the whole point: a lone winner-only play is not a
     * run, and tagging it would put a "1 plays" stack card in the feed where an
     * ordinary polaroid belongs. It is also what keeps a distinctive play — the
     * closest game, the one with a comment — on its own card without
     * groupKeyFor having to guess at which details are distinctive: whatever is
     * unique is alone at its key, and whatever is alone is never tagged.
     *
     * Computed once over the whole importable set before any chunk goes out,
     * so plays that land in different requests still agree on their group.
     * @param {DraftPlay[]} plays
     * @returns {Map<string, string>}
     */
    assignGroups(plays) {
      const byKey = new Map();
      for (const play of plays) {
        const k = this.groupKeyFor(play);
        if (!k) continue;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(play.id);
      }
      const out = new Map();
      for (const ids of byKey.values()) {
        if (ids.length < 2) continue;
        const groupId = uid();
        for (const id of ids) out.set(id, groupId);
      }
      return out;
    }

    /**
     * One draft play as the PlayCreate body the API takes.
     * @param {DraftPlay} play
     * @param {Map<string, string>} [groups] From assignGroups().
     */
    toPayload(play, groups, batchId) {
      const game = this.playGame(play);
      return {
        game_id: game ? game.id : null,
        played_at: this.dateFor(play),
        notes: play.notes || null,
        // Resolved and collapsed — see seats(). One account cannot be seated
        // twice here, which is both what the Players step promised and what
        // migration 023's unique index enforces at the other end.
        players: this.seats(play),
        // The idempotency key. Stable across attempts by construction — it is
        // the draft play's own id — so a chunk re-sent after a lost response
        // comes back as duplicates rather than a second set of plays.
        client_key: play.id,
        // Migration 005. Present only for a play that is one of several
        // indistinguishable ones; the feed and the plays log then show the
        // whole run as a single card.
        import_group_id: (groups && groups.get(play.id)) || null,
        // Migration 007. Every play in THIS import shares one, so the whole
        // paste can be undone from Settings later — including the one-offs,
        // which carry no group id and could never be found any other way.
        import_batch_id: batchId || null,
      };
    }

    /**
     * Write every importable play, a chunk at a time.
     * @param {(p: {done: number, total: number}) => void} onProgress
     */
    async run(onProgress) {
      const plays = this.importable();
      // Once, over the whole set, before the first chunk: a run split across
      // two requests has to carry the same group id in both, and every play in
      // this import has to share one batch id however many chunks it takes.
      const groups = this.assignGroups(plays);
      const batchId = uid();
      this.progress = { done: 0, total: plays.length, imported: 0, duplicate: 0, failed: 0, errors: [] };
      for (let i = 0; i < plays.length; i += CHUNK_SIZE) {
        const chunk = plays.slice(i, i + CHUNK_SIZE);
        const body = { plays: chunk.map((p) => this.toPayload(p, groups, batchId)) };
        let res;
        try {
          res = await window.api.post("/plays/import", body, { timeoutMs: IMPORT_TIMEOUT_MS });
        } catch (err) {
          // One retry: the common failure is a phone on a bad connection, and
          // the client_keys make a repeat free. Past that, stop rather than
          // grind through forty more chunks against a server that is down —
          // every play already written stays written, and re-running the
          // import lands only what is missing.
          try {
            res = await window.api.post("/plays/import", body, { timeoutMs: IMPORT_TIMEOUT_MS });
          } catch (err2) {
            this.progress.failed += chunk.length;
            this.progress.errors.push((err2 && err2.message) || "Upload failed");
            throw Object.assign(new Error((err2 && err2.message) || "Import failed"), {
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
        if (onProgress) onProgress(this.progress);
      }
      return this.progress;
    }

    // ── Draft persistence ────────────────────────────────────────────────────

    save() {
      try {
        // Photos are deliberately absent — see addPhoto. Everything here is
        // small and textual, which is what keeps a 500-play draft inside the
        // quota.
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: DRAFT_VERSION,
          step: this.step,
          text: this.text,
          hint: this.hint,
          plays: this.plays,
          playerNames: this.playerNames,
          playerMap: this.playerMap,
          gameRefs: this.gameRefs,
          gameMap: this.gameMap,
          warnings: this.warnings,
          bulkDate: this.bulkDate,
        }));
      } catch (_) {
        // A full or blocked quota costs the resume, not the import.
      }
    }

    clearDraft() {
      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    }

    /** Restore a saved draft onto this instance. True when one was read. */
    restore() {
      let raw = null;
      try { raw = localStorage.getItem(DRAFT_KEY); } catch (_) { return false; }
      if (!raw) return false;
      let data;
      try { data = JSON.parse(raw); } catch (_) { this.clearDraft(); return false; }
      if (!data || data.v !== DRAFT_VERSION || !Array.isArray(data.plays)) {
        this.clearDraft();
        return false;
      }
      this.step = Math.min(Math.max(0, Number(data.step) || 0), STEPS.length - 1);
      this.text = String(data.text || "");
      // Never restored, because never saved. A draft that was read from photos
      // resumes with its plays intact and its source empty; the source step
      // recognises that shape and says so rather than showing a blank box.
      this.clearPhotos();
      this.hint = String(data.hint || "");
      // Normalised rather than assigned, so a draft saved before seat editing
      // existed restores with the field explicitly absent instead of
      // undefined. That is what lets this stay an ADDITIVE change and keeps
      // DRAFT_VERSION where it is: an optional field with a null default and
      // an explicit normalisation here does not need a version bump, and
      // bumping would throw away every in-flight import on deploy day.
      // Changing the meaning of an existing field would.
      this.plays = (data.plays || []).map((p) => ({
        ...p,
        seatsOverride: p.seatsOverride || null,
      }));
      this.playerNames = data.playerNames || [];
      this.playerMap = data.playerMap || {};
      this.gameRefs = data.gameRefs || [];
      this.gameMap = data.gameMap || {};
      this.warnings = data.warnings || [];
      this.bulkDate = data.bulkDate || null;
      // Progress is deliberately not restored. A run that was interrupted
      // mid-write has an unknown outcome from the client's side; the safe
      // resume is to import again and let the client_keys deduplicate.
      this.progress = null;
      return true;
    }

    /** True once there is anything a refresh or a close would lose. */
    get isDirty() { return !!(this.text.trim() || this.photos.length || this.plays.length); }
  }

  window.PlayImport = PlayImport;
})();
