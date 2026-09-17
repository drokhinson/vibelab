// @ts-check
// domain/bga-import.js — the Board Game Arena source's model.
//
// The wizard's third draft model, answering the same `ImportSource` interface
// (domain/import-draft.js) as domain/play-import.js and domain/photo-import.js,
// which is what lets one review screen render all three.
//
// Structurally this is PlayImport's shape, not PhotoImport's: a global handle
// map, a global game map, per-play seat overrides, run collapse, and a chunked
// write. What it is NOT is a parse — BGA hands over structured, dated, scored
// tables, so there is no model in the loop and nothing to be wrong about
// except which person a handle belongs to.
//
// FOUR THINGS WORTH KNOWING BEFORE READING THE BRANCH:
//
//   • THE PASSWORD IS NEVER HERE. Not on the instance, not in the draft, not
//     in localStorage. The branch holds it for exactly as long as the link
//     call takes and drops it. save() writes an explicit field list, so this
//     is enforced by that list rather than by a rule somebody has to remember
//     — and tools/check-import-wizard.mjs asserts a saved draft contains no
//     "password" anywhere, because that is the kind of mistake that reads fine
//     in review.
//
//   • DEDUPE IS THE TABLE ID, NOT THE client_key. Every draft play still
//     carries a client_key (its own local id), the same as every other source.
//     But the key that makes "import any new plays" mean anything is
//     `bga_table_id`, unique per user in the database (migration 043): the
//     server answers a table you already imported with {duplicate: true}
//     whatever client_key it arrives under, so re-running this after any kind
//     of interruption is free.
//
//   • WINNER COMES FROM BGA'S RANK. `rank === 1`, not "highest score" — the
//     site already decided who won, and re-deriving it would disagree with
//     BGA on every game where the low score wins. Editable in the review like
//     everything else.
//
//   • THE HANDLE IS THE ONLY IDENTIFIER BGA GIVES. There is no email and no
//     other key, which is why the server remembers handle → person mappings
//     (boardgamebuddy_bga_player_links) and why the first import is work and
//     the second is a glance. `matchReasons` carries WHY each handle resolved
//     the way it did, so the Players step can label a suggestion by its reason
//     rather than by a score (.claude/rules/web-frontend.md).
//
// ON THIS FILE'S LENGTH. It is over the ~300-line guidance in
// .claude/rules/web-frontend.md, as its two sibling models are (1175 and 753).
// The genuinely shared half — the seat collapse — is extracted to
// domain/import-seats.js rather than copied a third time. What is left is one
// model whose parts call each other on nearly every line, and splitting that
// across two files in a no-modules codebase means Object.assign onto a
// prototype, which nothing else here does and which the gate's interface sweep
// would have to learn about. One file that matches its siblings reads better.

(function () {
  const DRAFT_KEY = "bgb.bgaImport.draft";
  // Bump when the draft SHAPE changes. An additive optional field with a null
  // default and an explicit normalisation in restore() does not need a bump —
  // see PlayImport.restore's note on why bumping throws away every in-flight
  // import on deploy day.
  const DRAFT_VERSION = 1;

  // Mirrors IMPORT_CHUNK_MAX in api/routes/constants.py.
  const CHUNK_SIZE = 50;
  // The sweep walks up to BGA_MAX_TABLES tables behind a 2-second throttle, so
  // this is minutes rather than seconds. The server caps itself at
  // BGA_SWEEP_BUDGET_SECONDS; this only has to outlive that.
  const FETCH_TIMEOUT_MS = 300000;
  const IMPORT_TIMEOUT_MS = 60000;
  // How often the branch polls the sweep's ledger.
  const PROGRESS_POLL_MS = 1500;

  // The wizard's full path for this source. The branch owns only the first
  // three; `review` and `import` are the shared screens every source lands on.
  const STEPS = ["account", "fetch", "players", "games", "review", "import"];

  /**
   * @typedef {Object} DraftSeat
   * @property {string} handle    The BGA username. The mapping key.
   * @property {boolean} isWinner Derived from BGA's rank === 1.
   * @property {number|null} score
   * @property {number|null} rank
   */

  /**
   * @typedef {Object} DraftTable
   * @property {string} id            Local id — also the client_key sent to the API.
   * @property {number} bgaTableId    The dedupe key. Unique per user server-side.
   * @property {string} gameName      As BGA names it. Keys into `gameMap`.
   * @property {string|null} gameId   Per-play override; falls back to the mapping.
   * @property {string|null} playedAt ISO date, or null when BGA gave none.
   * @property {DraftSeat[]} seats    As BGA reported the table.
   * @property {Array<{name: string, is_winner: boolean, score: number|null,
   *   user_id: string|null}>|null} [seatsOverride]  This table, exactly — set
   *   the first time the user edits its seats, after which it no longer
   *   follows the global handle mapping. See _materialise().
   * @property {boolean} dropped      Kept rather than spliced, so undo works.
   */

  /**
   * @typedef {Object} HandleMapping
   * @property {"buddy"|"ghost"} kind
   * @property {string|null} userId  Set for kind "buddy".
   * @property {string} label        What the review list shows.
   */

  const uid = () => (
    (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      // Older WebKit. Only has to be unique per draft — the server treats it
      // as an opaque idempotency key.
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
      })
  );

  const key = (s) => String(s || "").trim().toLowerCase();

  const todayIso = () => {
    // Local date, not toISOString() — that is UTC, so an evening table in a
    // western timezone would import as tomorrow.
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** whoOf, via the shared module. Must agree with the other two models. */
  const whoOf = (seat) => window.ImportSeats.whoOf(seat);
  const collapse = (seats) => window.ImportSeats.collapse(seats);

  class BgaImport {
    constructor() { this.reset(); }

    reset() {
      this.step = 0;
      /** @type {{username: string|null, playerId: string|null, authState: string, lastImportAt: string|null}} */
      this.link = { username: null, playerId: null, authState: "unlinked", lastImportAt: null };
      /** @type {DraftTable[]} */
      this.tables = [];
      /** @type {string[]} Distinct BGA handles, first-seen order. */
      this.handles = [];
      /** @type {Object<string, HandleMapping>} keyed by lowercased handle. */
      this.handleMap = {};
      /** @type {Object<string, string>} handle → why it resolved that way. */
      this.matchReasons = {};
      /** @type {Array<{name: string, candidates: any[], confident: boolean}>} */
      this.gameRefs = [];
      /** @type {Object<string, {id: string, name: string, thumbnail_url: string|null}|null>} */
      this.gameMap = {};
      /** Tables the sweep found that this account already has. */
      this.skipped = 0;
      /** True when a cap was hit and older history is still on BGA. */
      this.truncated = false;
      /** @type {any} The sweep's ledger while it runs. Never persisted. */
      this.fetchProgress = null;
      /** @type {{done: number, total: number, imported: number, duplicate: number, failed: number, errors: string[]}|null} */
      this.progress = null;
    }

    get stepName() { return STEPS[this.step] || STEPS[0]; }
    static get steps() { return STEPS.slice(); }
    /** Part of the ImportSource statics the gate sweeps; every model has one. */
    static get today() { return todayIso(); }
    static get chunkSize() { return CHUNK_SIZE; }
    static get fetchTimeoutMs() { return FETCH_TIMEOUT_MS; }
    static get pollMs() { return PROGRESS_POLL_MS; }
    /** Exposed so the gate can assert the key shape matches the other models. */
    static whoOf(seat) { return whoOf(seat); }

    // ── Ingesting the sweep ──────────────────────────────────────────────────

    /**
     * Replace every downstream field from one `POST /bga/tables/fetch` answer.
     *
     * A re-fetch starts over rather than merging: the server already excludes
     * what this account has imported, so a second sweep is the authoritative
     * answer to "what is left", and merging would resurrect tables the user
     * dropped on purpose.
     * @param {any} res BgaFetchResponse
     */
    ingest(res) {
      const tables = (res && res.tables) || [];
      this.tables = tables.map((t) => ({
        id: uid(),
        bgaTableId: Number(t.bga_table_id),
        gameName: String(t.game_name || ""),
        gameId: null,
        playedAt: t.played_at || null,
        seats: ((t.seats) || []).map((s) => ({
          handle: String(s.handle || ""),
          isWinner: !!s.is_winner,
          score: (s.score === 0 || s.score) ? s.score : null,
          rank: (s.rank === 0 || s.rank) ? s.rank : null,
        })),
        seatsOverride: null,
        dropped: false,
      })).filter((t) => Number.isFinite(t.bgaTableId));

      this.skipped = Number((res && res.skipped) || 0);
      this.truncated = !!(res && res.truncated);
      this.gameRefs = (res && res.games) || [];

      // Pre-select the games the catalog matched unambiguously, the same way
      // the note importer's parse does.
      this.gameMap = {};
      for (const ref of this.gameRefs) {
        if (ref && ref.confident && ref.candidates && ref.candidates[0]) {
          this.setGame(ref.name, ref.candidates[0]);
        }
      }

      this.handles = [];
      const seen = new Set();
      for (const table of this.tables) {
        for (const seat of table.seats) {
          const k = key(seat.handle);
          if (k && !seen.has(k)) { seen.add(k); this.handles.push(seat.handle); }
        }
      }

      this.applyMatches((res && res.handles) || []);
    }

    /**
     * Seat the handles the server could resolve, and record WHY for the rest.
     *
     * VIEWER and REMEMBERED are applied. CROSS_ACCOUNT is applied too, but its
     * reason is kept so the Players step can show it as a match the user can
     * undo rather than as a silent fact — it is somebody else's claim about a
     * shared username, and seating a stranger at your table quietly is not a
     * thing to do. FUZZY is not the server's to give: the ranker lives on the
     * client (domain/name-match.js) and runs once the buddy list has landed.
     * @param {any[]} matches BgaHandleMatch[]
     */
    applyMatches(matches) {
      for (const match of matches || []) {
        const handle = String((match && match.handle) || "");
        if (!handle) continue;
        const reason = String((match && match.reason) || "none");
        this.matchReasons[key(handle)] = reason;
        if (reason === "none") continue;
        const userId = (match && match.player_user_id) || null;
        // Falls back to the handle itself: a remembered ghost keeps whatever
        // spelling the user gave it, and an account with no display name
        // reaching us is better seated under its handle than under "".
        const label = String((match && match.player_display_name) || handle);
        this.setPlayer(handle, userId
          ? { kind: "buddy", userId, label }
          : { kind: "ghost", userId: null, label });
      }
    }

    /**
     * Fill in anything the server left unresolved, using the local name ranker.
     *
     * Only ever a SUGGESTION applied to an untouched handle: BGA handles often
     * look nothing like real names, so a confident-looking fuzzy hit is much
     * weaker evidence here than it is on a handwritten note. The Players step
     * shows the reason, and the user can change it in one tap.
     * @param {any} partners The bundle from ImportPeople.loadPartners().
     */
    suggestPlayers(partners) {
      if (!partners) return;
      const candidates = window.ImportPeople.candidates(partners);
      const mine = key(this.link.username || "");
      for (const handle of this.handles) {
        const k = key(handle);
        // Never overwrite a resolution the server made or the user chose.
        if (this.handleMap[k]) continue;
        if (mine && k === mine) continue;
        const close = window.ImportPeople.closestTo(handle, candidates, 1,
          // A BGA handle IS a username, so rank usernames ahead of display
          // names — the opposite of the note importer, which reads names the
          // way people say them out loud. domain/name-match.js docks a penalty
          // off every field after the first, so the order is the whole signal.
          (c) => [c.username, c.name]);
        const best = close && close[0];
        if (!best) continue;
        this.matchReasons[k] = "fuzzy";
        this.setPlayer(handle, best.user_id
          ? { kind: "buddy", userId: best.user_id, label: best.name }
          : { kind: "ghost", userId: null, label: best.name });
      }
    }

    /** Why a handle resolved the way it did — "remembered", "fuzzy", … */
    matchReason(handle) { return this.matchReasons[key(handle)] || "none"; }

    // ── Handle and game mappings ─────────────────────────────────────────────

    /**
     * Record who a handle is. Leaves `matchReasons` alone — the caller owns
     * the reason, because the same assignment means different things depending
     * on who made it.
     * @param {string} handle @param {HandleMapping} mapping
     */
    setPlayer(handle, mapping) {
      this.handleMap[key(handle)] = mapping;
    }

    /**
     * The user picked this one themselves.
     *
     * Separate from setPlayer so the reason is overwritten: a row that still
     * said "matched before" after the user changed it would be the app
     * insisting on an answer they had just corrected.
     * @param {string} handle @param {HandleMapping} mapping
     */
    setPlayerByHand(handle, mapping) {
      this.setPlayer(handle, mapping);
      this.matchReasons[key(handle)] = "user";
    }

    /** @param {string} handle @returns {HandleMapping} */
    playerMapping(handle) {
      return this.handleMap[key(handle)]
        || { kind: "ghost", userId: null, label: handle };
    }

    /** Alias, so the Players step reads the same as the note importer's. */
    get playerNames() { return this.handles; }

    /** @param {string} gameName @param {any|null} game */
    setGame(gameName, game) {
      this.gameMap[key(gameName)] = game
        ? { id: game.id, name: game.name, thumbnail_url: game.thumbnail_url || null }
        : null;
    }

    /** @param {string} gameName */
    gameMapping(gameName) { return this.gameMap[key(gameName)] || null; }

    /** Resolved game for one table — its own override, else the mapping. */
    playGame(table) {
      if (table.gameId) {
        for (const g of Object.values(this.gameMap)) {
          if (g && g.id === table.gameId) return g;
        }
        return { id: table.gameId, name: table.gameName, thumbnail_url: null };
      }
      return this.gameMapping(table.gameName);
    }

    /** Game names still unresolved, and how many live tables each costs. */
    unresolvedGames() {
      const counts = {};
      for (const t of this.tables) {
        if (t.dropped || t.gameId) continue;
        const k = key(t.gameName);
        if (this.gameMap[k]) continue;
        counts[k] = counts[k] || { name: t.gameName, plays: 0 };
        counts[k].plays++;
      }
      return Object.values(counts);
    }

    // ── The review list ──────────────────────────────────────────────────────

    /** Live tables, grouped into the review list's per-game subsections. */
    groups() {
      const out = [];
      const byKey = new Map();
      for (const table of this.tables) {
        if (table.dropped) continue;
        const game = this.playGame(table);
        const k = game ? `id:${game.id}` : `name:${key(table.gameName)}`;
        let group = byKey.get(k);
        if (!group) {
          group = { key: k, name: game ? game.name : table.gameName, game, plays: [] };
          byKey.set(k, group);
          out.push(group);
        }
        group.plays.push(table);
      }
      return out;
    }

    /**
     * One group's tables as review rows.
     *
     * ONE TABLE IS ONE ROW, always — unlike the note importer, where a tally
     * of 58 identical plays collapses into one editable row. Two BGA tables
     * are two distinct events with their own ids however alike they look, and
     * collapsing them would hide a real game behind a count. `rowKeyFor` still
     * exists because the feed's grouping reads it.
     * @param {DraftTable[]} tables
     */
    rows(tables) {
      return (tables || []).map((table) => ({
        key: this.rowKeyFor(table),
        runId: null,
        plays: [table],
      }));
    }

    /**
     * What a reader would use to tell two plays apart, after everything the
     * user has resolved. Feeds `groupKeyFor`, so the row the user reviews and
     * the card the feed shows cannot disagree.
     * @param {DraftTable} table
     */
    rowKeyFor(table) {
      const game = this.playGame(table);
      const seats = this.seats(table)
        .map((s) => window.ImportSeats.seatKey(s)).sort();
      return [
        game ? `id:${game.id}` : `name:${key(table.gameName)}`,
        this.dateFor(table),
        "",
        seats.join(","),
      ].join("|");
    }

    /**
     * THE SEATS OF ONE TABLE, AS THEY WILL BE WRITTEN — resolved through the
     * Players step and collapsed wherever two handles turned out to be one
     * person.
     *
     * The collapse is not hypothetical here: one person can hold two BGA
     * accounts, and a user who points both at the same buddy would otherwise
     * send a play seating that account twice, which migration 023's unique
     * index refuses outright.
     * @param {DraftTable} table
     */
    seats(table) {
      // An edited table answers for itself — see _materialise().
      if (table && table.seatsOverride) return collapse(table.seatsOverride);
      return collapse(((table && table.seats) || []).map((seat) => {
        const m = this.playerMapping(seat.handle);
        return {
          name: m.label || seat.handle,
          is_winner: !!seat.isWinner,
          score: (seat.score === 0 || seat.score) ? seat.score : null,
          user_id: m.userId || null,
        };
      }));
    }

    /** @param {DraftTable} table */
    dateFor(table) { return table.playedAt || todayIso(); }

    /** The review row a table belongs to. Derived, so recomputed not indexed. */
    rowFor(tableId) {
      for (const group of this.groups()) {
        for (const row of this.rows(group.plays)) {
          if (row.plays.some((t) => t.id === tableId)) return row;
        }
      }
      return null;
    }

    get liveCount() { return this.tables.filter((t) => !t.dropped).length; }

    /**
     * Tables that will actually be written — live, with a resolved game, and
     * with somebody at the table (migration 023's invariant, met here as a
     * count the user can act on rather than as a play the server refuses).
     */
    importable() {
      return this.tables.filter(
        (t) => !t.dropped && !!this.playGame(t) && this.seats(t).length > 0,
      );
    }

    /** Live tables whose game resolved but whose roster is empty. */
    seatless() {
      return this.tables.filter(
        (t) => !t.dropped && !!this.playGame(t) && this.seats(t).length === 0,
      );
    }

    // ── The shared review adapter ────────────────────────────────────────────

    /** @returns {"bga"} */
    get sourceKey() { return "bga"; }

    /**
     * The catalog game of one item in `importable()`. Part of the ImportSource
     * interface — see PlayImport.gameOf. A BGA table resolves through the game
     * map, like a note's play.
     * @param {DraftTable} table
     */
    gameOf(table) { return this.playGame(table); }

    /**
     * Every BGA table carries the day it ended, from the site's own record.
     * Offering a bulk date would offer to overwrite the one thing this source
     * is certain about.
     */
    get supportsBulkDate() { return false; }

    /**
     * The one thing worth warning about before the review: history left behind.
     * Everything else this source could get wrong is a row the user can see.
     */
    reviewWarnings() {
      if (!this.truncated) return [];
      return [
        "This run reached its limit before the end of your Board Game Arena "
        + "history. Import these, then run it again for the older ones — nothing "
        + "you've already imported will be offered twice.",
      ];
    }

    reviewGroups() {
      return this.groups().map((group) => ({
        key: group.key,
        name: group.name,
        game: group.game,
        rows: this.rows(group.plays).map((row) => this._reviewRow(row)),
      }));
    }

    _reviewRow(row) {
      const first = row.plays[0];
      return {
        id: first.id,
        count: 1,
        // One table is one play — there is no count to edit.
        countEditable: false,
        game: this.playGame(first),
        playedAt: this.dateFor(first),
        notes: null,
        thumbUrl: null,
        countryCode: null,
        seats: this.seats(first),
        edited: !!first.seatsOverride,
        runNote: null,
      };
    }

    /** The third summary tile. Plays and Games are the same for every source. */
    summaryTile() {
      const ready = this.importable().length;
      return {
        label: "From Board Game Arena",
        value: ready,
        note: this.skipped
          ? `${this.skipped} you already had`
          : null,
      };
    }

    /**
     * Why a table is being left behind, counted apart because each has its own
     * fix. "12 plays won't import" without saying which problem to go and
     * solve is not a warning.
     */
    reviewNotices() {
      const seatless = this.seatless().length;
      const gameless = this.liveCount - this.importable().length - seatless;
      const out = [];
      if (gameless) {
        out.push({
          count: gameless,
          text: `${gameless} table${gameless === 1 ? "" : "s"} won't be imported — `
              + `no game matched. Go back to Games to match `
              + `${gameless === 1 ? "it" : "them"}.`,
        });
      }
      if (seatless) {
        out.push({
          count: seatless,
          text: `${seatless} table${seatless === 1 ? "" : "s"} won't be imported — `
              + `nobody at the table. A play needs at least one player, or it counts `
              + `towards nobody's record and no ghost can ever claim it.`,
        });
      }
      if (this.skipped) {
        out.push({
          count: this.skipped,
          text: `${this.skipped} table${this.skipped === 1 ? "" : "s"} from Board Game `
              + `Arena ${this.skipped === 1 ? "is" : "are"} already in your plays, so `
              + `${this.skipped === 1 ? "it isn't" : "they aren't"} offered here.`,
        });
      }
      if (this.truncated) {
        out.push({
          count: 0,
          text: `There is older Board Game Arena history this run didn't reach. `
              + `Import these, then start another import for the rest.`,
        });
      }
      return out;
    }

    ctaNote() {
      return "Nothing is written until you press this. A table you've already "
           + "imported is skipped, so running this again is always safe.";
    }

    /** @param {any} p @param {boolean} busy */
    progressHeading(p, busy) {
      return busy ? "Importing…" : (p && p.failed ? "Import finished" : "Imported");
    }

    progressNote() { return null; }

    // ── Row edits the shared review drives ───────────────────────────────────

    setRowGame(tableId, game) {
      const row = this.rowFor(tableId);
      if (!row || !game) return false;
      for (const table of row.plays) table.gameId = game.id;
      // The global mapping too, or a later edit on the Games step silently
      // reverts this one.
      this.setGame(game.name, game);
      return true;
    }

    setRowDate(tableId, iso) {
      const row = this.rowFor(tableId);
      if (!row) return false;
      for (const table of row.plays) table.playedAt = iso || null;
      return true;
    }

    /**
     * One BGA table is one play, so there is no count to resize. Returning
     * false rather than throwing keeps the shared review's contract — the step
     * reads `countEditable` and never offers the control.
     */
    setRowCount() { return false; }

    dropRow(tableId) {
      const row = this.rowFor(tableId);
      if (!row) return false;
      for (const table of row.plays) table.dropped = true;
      return true;
    }

    // ── Per-table seat editing ───────────────────────────────────────────────

    /**
     * Detach a table's roster from the global handle mapping, seeded with what
     * that mapping currently says.
     *
     * Seats are DERIVED, and the handle map is one entry across the whole
     * import — so taking somebody off one table by editing the map would take
     * them off every table they played. The override is the third layer: "this
     * table, exactly".
     * @param {DraftTable} table
     */
    _materialise(table) {
      if (!table.seatsOverride) table.seatsOverride = this.seats(table);
      return table.seatsOverride;
    }

    _editRow(tableId, fn) {
      const row = this.rowFor(tableId);
      if (!row) return false;
      for (const table of row.plays) {
        const next = fn(this._materialise(table).map((s) => ({ ...s })));
        if (next) table.seatsOverride = next;
      }
      return true;
    }

    /** @param {string} tableId @param {any[]} picks PlayerCandidate rows. */
    addSeats(tableId, picks) {
      if (!picks || !picks.length) return false;
      return this._editRow(tableId, (seats) => seats.concat(picks.map((pick) => ({
        name: pick.name,
        is_winner: false,
        score: null,
        user_id: pick.user_id || null,
      }))));
    }

    /** @param {string} tableId @param {string} who A whoOf() key. */
    removeSeat(tableId, who) {
      return this._editRow(tableId, (seats) => seats.filter((s) => whoOf(s) !== who));
    }

    /** Several winners is a tie, so this toggles one seat rather than moving a crown. */
    toggleWinner(tableId, who) {
      return this._editRow(tableId, (seats) => seats.map((s) => (
        whoOf(s) === who ? { ...s, is_winner: !s.is_winner } : s
      )));
    }

    /**
     * One final score for one seat. Blank clears it back to null rather than
     * writing 0 — a game nobody recorded a score for is not a game everybody
     * scored nothing in.
     */
    setScore(tableId, who, value) {
      const raw = String(value == null ? "" : value).trim();
      const score = raw === "" ? null : Math.trunc(Number(raw));
      if (score != null && !Number.isFinite(score)) return false;
      return this._editRow(tableId, (seats) => seats.map((s) => (
        whoOf(s) === who ? { ...s, score } : s
      )));
    }

    // ── The write ────────────────────────────────────────────────────────────

    /**
     * The identity of a table for FEED grouping, or null when it cannot be
     * grouped. Same rule as the note importer: whatever is unique is alone at
     * its key, and whatever is alone is never tagged.
     */
    groupKeyFor(table) {
      if (!this.playGame(table)) return null;
      return this.rowKeyFor(table);
    }

    /** Mint one group id per key covering MORE THAN ONE table. */
    assignGroups(tables) {
      const byKey = new Map();
      for (const table of tables) {
        const k = this.groupKeyFor(table);
        if (!k) continue;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(table.id);
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
     * One draft table as the PlayCreate body the API takes.
     *
     * No photo_url and no country_code: BGA gives neither, and sending an
     * empty one would be this source claiming something it does not know.
     * @param {DraftTable} table
     */
    toPayload(table, groups, batchId) {
      const game = this.playGame(table);
      return {
        game_id: game ? game.id : null,
        played_at: this.dateFor(table),
        notes: null,
        players: this.seats(table),
        client_key: table.id,
        import_group_id: (groups && groups.get(table.id)) || null,
        import_batch_id: batchId || null,
        // Migration 040. THE key that makes a re-import safe: the server
        // answers a table already imported with {duplicate: true} whatever
        // client_key it arrives under.
        bga_table_id: table.bgaTableId,
      };
    }

    /**
     * Write every importable table, a chunk at a time.
     * @param {(p: {done: number, total: number}) => void} [onProgress]
     */
    async run(onProgress) {
      const tables = this.importable();
      const groups = this.assignGroups(tables);
      const batchId = uid();
      this.progress = {
        done: 0, total: tables.length, imported: 0, duplicate: 0, failed: 0, errors: [],
      };
      for (let i = 0; i < tables.length; i += CHUNK_SIZE) {
        const chunk = tables.slice(i, i + CHUNK_SIZE);
        const body = { plays: chunk.map((t) => this.toPayload(t, groups, batchId)) };
        let res;
        try {
          res = await window.api.post("/plays/import", body, { timeoutMs: IMPORT_TIMEOUT_MS });
        } catch (err) {
          // One retry: the common failure is a phone on a bad connection, and
          // both keys make a repeat free. Past that, stop rather than grind
          // through the rest against a server that is down — everything
          // already written stays written, and re-running lands the rest.
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
      // Remember every handle the user resolved, so the next import pre-seats
      // it. Fire-and-forget on purpose: a failed remember costs the NEXT
      // import one tap, and must never cost this one.
      this._rememberHandles();
      return this.progress;
    }

    /** The handle → person mappings worth carrying to the next import. */
    rememberPayload() {
      const links = [];
      for (const handle of this.handles) {
        const k = key(handle);
        // The viewer's own handle is not a mapping anyone needs remembered.
        if (key(this.link.username || "") === k) continue;
        const m = this.handleMap[k];
        if (!m) continue;
        links.push({
          bga_handle: handle,
          player_user_id: m.userId || null,
          player_display_name: m.userId ? null : (m.label || handle),
        });
      }
      return links;
    }

    _rememberHandles() {
      const links = this.rememberPayload();
      if (!links.length) return;
      try {
        const p = window.api.post("/bga/players/remember", { links });
        if (p && p.catch) p.catch(() => {});
      } catch (_) {
        // Never a reason to fail an import that has already landed.
      }
    }

    // ── Draft persistence ────────────────────────────────────────────────────

    save() {
      try {
        // An EXPLICIT field list, and that is what keeps the password out —
        // there is no `password` on this instance to begin with, and a field
        // list means a future one could not leak in by accident either.
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: DRAFT_VERSION,
          step: this.step,
          link: {
            username: this.link.username,
            playerId: this.link.playerId,
            authState: this.link.authState,
            lastImportAt: this.link.lastImportAt,
          },
          tables: this.tables,
          handles: this.handles,
          handleMap: this.handleMap,
          matchReasons: this.matchReasons,
          gameRefs: this.gameRefs,
          gameMap: this.gameMap,
          skipped: this.skipped,
          truncated: this.truncated,
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
      if (!data || data.v !== DRAFT_VERSION || !Array.isArray(data.tables)) {
        this.clearDraft();
        return false;
      }
      this.step = Math.min(Math.max(0, Number(data.step) || 0), STEPS.length - 1);
      this.link = {
        username: (data.link && data.link.username) || null,
        playerId: (data.link && data.link.playerId) || null,
        authState: (data.link && data.link.authState) || "unlinked",
        lastImportAt: (data.link && data.link.lastImportAt) || null,
      };
      // Normalised rather than assigned, so an additive optional field stays
      // additive and DRAFT_VERSION can stay where it is. Bumping would throw
      // away every in-flight import on deploy day.
      this.tables = (data.tables || []).map((t) => ({
        ...t,
        seats: (t.seats || []).map((s) => ({
          handle: s.handle,
          isWinner: !!s.isWinner,
          score: (s.score === 0 || s.score) ? s.score : null,
          rank: (s.rank === 0 || s.rank) ? s.rank : null,
        })),
        seatsOverride: t.seatsOverride || null,
        dropped: !!t.dropped,
      }));
      this.handles = data.handles || [];
      this.handleMap = data.handleMap || {};
      this.matchReasons = data.matchReasons || {};
      this.gameRefs = data.gameRefs || [];
      this.gameMap = data.gameMap || {};
      this.skipped = Number(data.skipped || 0);
      this.truncated = !!data.truncated;
      // Neither is restored. The sweep's ledger died with the request that
      // wrote it, and a run interrupted mid-write has an unknown outcome from
      // the client's side — the safe resume is to import again and let the
      // table ids deduplicate.
      this.fetchProgress = null;
      this.progress = null;
      return true;
    }

    /** True once there is anything a refresh or a close would lose. */
    get isDirty() { return !!this.tables.length; }
  }

  window.BgaImport = BgaImport;
})();
