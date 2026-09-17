// domain/bgg-play-import.js — the import wizard's BOARDGAMEGEEK draft.
//
// The third model behind `@typedef ImportSource` (domain/import-draft.js), and
// the one that finally makes the wizard the only way a play reaches this
// database. BGG plays used to be written by POST /bgg/sync, straight into
// boardgamebuddy_plays — around bgb_log_play, around this review, and with
// migration 023's roster rules re-implemented server-side in _player_rows.
//
// ─── Why this is a third model rather than a mode on PlayImport ──────────────
//
// The same argument the notes and photos models already settled: one is a
// parse → name-map → run-collapse machine, the other an EXIF → per-file-upload
// machine, and merging them is a thousand lines of `if (source === …)`. This
// one is a fetch → name-map → game-map machine. What makes one review render
// all three is the interface, not a shared implementation.
//
// ─── Three things it does differently, and why ──────────────────────────────
//
// 1. GAMES ARE KEYED BY BGG ID, NOT BY NAME. The notes model has a string the
//    user wrote and has to search the catalog for it; this has BoardGameGeek's
//    own id, which is exactly what the catalog stores in `bgg_id`. So the Games
//    step is not a search — it is "BgB has never heard of this game, import it"
//    — and two games that happen to share a name cannot collide.
//
// 2. EVERY PLAY CARRIES ITS bgg_play_id INTO THE PAYLOAD. That is the second
//    idempotency key (migration 040), beside the client_key every source sends.
//    The client_key makes re-running THIS draft free; the BGG id makes
//    re-running from a different draft, another device, or after the retired
//    sync already landed the play free as well. Nothing else can see those
//    rows — they carry no client_key at all.
//
// 3. A PLAY WITH NO ROSTER IS SEATED WITH THE VIEWER. Most BGG plays do not
//    record a `<players>` element, and migration 023 refuses a play with nobody
//    at the table. The retired sync did this server-side; dropping it here
//    would mean the wizard silently imports fewer plays than the thing it
//    replaced. It is not an invention either: the play is on the user's own BGG
//    account, and boardgamebuddy_plays.user_id already says whose play it is.
//
// Rows collapse the way the notes model's do — indistinguishable plays become
// one review row and one feed card — because two BGG plays of the same game, on
// the same day, with the same people and the same scores are the thing a stack
// card is for. What is NOT offered is resizing a row: a cloned play would have
// no BGG id of its own, and every play here is a record that exists on somebody
// else's server.

(function () {
  const DRAFT_KEY = "bgb.bggPlayImport.draft";
  // Bump when the stored shape changes; a draft at another version is
  // discarded rather than half-restored. Same rule as the other two models.
  const DRAFT_VERSION = 1;

  const CHUNK_SIZE = 50;
  const IMPORT_TIMEOUT_MS = 60000;

  // This branch's steps, plus the two shared screens every source ends on.
  const STEPS = ["plays", "players", "games", "review", "import"];

  /**
   * @typedef {Object} BggDraftPlayer
   * @property {string} name        As BoardGameGeek recorded it. The mapping key.
   * @property {string|null} bggUsername  The BGG account at this seat, if any.
   * @property {boolean} isWinner
   * @property {number|null} score  Always null — BGG's /plays does not carry one.
   */

  /**
   * @typedef {Object} BggDraftPlay
   * @property {string} id           Local id — also the client_key sent to the API.
   * @property {number} bggPlayId    BoardGameGeek's own id for this play.
   * @property {number} bggGameId    Its BGG game id. Keys into `gameMap`.
   * @property {string} bggGameName  BGG's name for that game.
   * @property {string} playedAt     ISO date. Never null: BGG drops dateless plays.
   * @property {string|null} notes
   * @property {number} quantity     Echoed from BGG, never expanded. See the header.
   * @property {BggDraftPlayer[]} players
   * @property {any[]|null} seatsOverride  Set on the first per-play seat edit.
   * @property {boolean} dropped
   */

  const uid = () => (
    (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
      })
  );

  const key = (s) => String(s || "").trim().toLowerCase();

  class BggPlayImport {
    constructor() { this.reset(); }

    reset() {
      this.step = 0;
      /** @type {string|null} The linked handle these plays came from. */
      this.bggUsername = null;
      /** @type {BggDraftPlay[]} */
      this.plays = [];
      /** @type {string[]} Distinct player names, first-seen order. */
      this.playerNames = [];
      /** @type {Object<string, NameMapping>} keyed by lowercased name. */
      this.playerMap = {};
      /**
       * BGG game id → the catalog row, or null when BgB has never seen it.
       * Keyed by id and not by name: see the header.
       * @type {Object<string, {id: string, name: string, thumbnail_url: string|null}|null>}
       */
      this.gameMap = {};
      /** Every play on the account, so the review can say what it left behind. */
      this.totalNew = 0;
      this.truncated = false;
      this.fetchedAt = null;
      /** @type {{done: number, total: number, imported: number, duplicate: number, failed: number, errors: string[]}|null} */
      this.progress = null;
    }

    get stepName() { return STEPS[this.step] || STEPS[0]; }
    static get steps() { return STEPS.slice(); }

    /**
     * Today, local. On the contract because the shared review's per-row date
     * input reads `model.constructor.today` for its `max` — every source, not
     * just the one with a bulk date — so a model without it renders
     * max="undefined" and lets somebody date a play in the future.
     */
    static get today() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    // ── The read ─────────────────────────────────────────────────────────────

    /**
     * POST /bgg/plays/pending, through domain/bgg.js so this model does not
     * keep a second copy of that endpoint's deadline argument.
     */
    static fetchPending() { return window.Bgg.pendingPlays(); }

    /**
     * Take a POST /bgg/plays/pending body into a draft.
     *
     * Deliberately NOT merged into whatever is already here: a second read is
     * a fresh answer to "what is missing", and the plays it drops are the ones
     * the user has since imported.
     * @param {any} res
     */
    adopt(res) {
      /** @type {BggDraftPlay[]} plays BGG recorded no roster for. */
      const seatless = [];
      this.bggUsername = (res && res.bgg_username) || null;
      this.totalNew = (res && res.total_new) || 0;
      this.truncated = !!(res && res.truncated);
      this.fetchedAt = (res && res.fetched_at) || null;
      this.gameMap = {};
      this.plays = ((res && res.plays) || []).map((p) => {
        if (p.game) this.setGame(p.bgg_id, p.game);
        const play = {
          id: uid(),
          bggPlayId: p.bgg_play_id,
          bggGameId: p.bgg_id,
          bggGameName: p.bgg_game_name || `BGG #${p.bgg_id}`,
          playedAt: p.played_at,
          notes: p.notes || null,
          quantity: p.quantity || 1,
          players: (p.players || []).map((pl) => ({
            name: pl.name,
            bggUsername: pl.username || null,
            isWinner: !!pl.is_winner,
            // BGG's /plays carries no score. The review is where one gets
            // typed in, which is more than the retired sync ever offered.
            score: null,
          })),
          seatsOverride: null,
          dropped: false,
        };
        if (!play.players.length) seatless.push(play);
        return play;
      });
      this.playerNames = ((res && res.players) || []).slice();
      this.playerMap = {};
      this._seatTheViewer(seatless);
      return this;
    }

    /**
     * Give a play BoardGameGeek recorded no roster for ONE seat: the account it
     * was imported from.
     *
     * Most BGG plays carry no `<players>` at all, and migration 023 refuses a
     * play with nobody at the table — so without this the wizard would import
     * dramatically fewer plays than the sync it replaces, and say nothing about
     * it beyond a "nobody at the table" notice the user cannot act on. It is
     * not an invention: the play is on the user's own BGG account, and
     * boardgamebuddy_plays.user_id already records whose play it is. It moves
     * no counter either — the seat lands with is_winner false, and win_count
     * reads winning seats.
     *
     * Seeded as an ordinary PLAYER rather than as a seatsOverride, because an
     * override means "the user edited this table" and would mark every one of
     * these rows as edited in the review. As a player it flows through the
     * Players step like any other name, where it is visible and correctable —
     * and it maps to the viewer's account rather than to a ghost, because it
     * carries the linked handle and suggestPlayers checks that first.
     * @param {BggDraftPlay[]} plays
     */
    _seatTheViewer(plays) {
      if (!plays.length) return;
      const me = window.ImportPeople.viewerRow();
      // No signed-in user is not a state the wizard can reach, but seating a
      // play with an empty name would land a blank row on a scoreboard. The
      // review's "nobody at the table" notice covers it honestly instead.
      if (!me || !me.name) return;
      for (const play of plays) {
        play.players = [{
          name: me.name,
          bggUsername: this.bggUsername,
          isWinner: false,
          score: null,
        }];
      }
      if (!this.playerNames.some((n) => key(n) === key(me.name))) {
        this.playerNames.push(me.name);
      }
    }

    // ── Player mapping ───────────────────────────────────────────────────────

    /**
     * Pre-map what can be mapped without asking.
     *
     * The BGG USERNAME goes first and is checked against the linked handle,
     * which is the one identity here that is not a guess: a seat BGG recorded
     * as the syncing account IS the syncing account. Everything after it is
     * domain/name-match.js doing exactly what it does for a pasted note.
     * @param {{accounts?: any[], ghosts?: any[], recent?: any[]}|null} partners
     */
    suggestPlayers(partners) {
      const people = window.ImportPeople.candidates(partners);
      const accounts = people.filter((c) => c.user_id);
      const ghosts = people.filter((c) => !c.user_id);
      const me = (window.store && window.store.get && window.store.get("user")) || null;
      const meRow = me
        ? [{ user_id: me.id, name: me.display_name || me.username || "", username: me.username || null }]
        : [];

      // Which draft names BGG itself says are the linked account.
      const mine = new Set();
      const handle = key(this.bggUsername);
      if (handle) {
        for (const play of this.plays) {
          for (const pl of play.players) {
            if (key(pl.bggUsername) === handle) mine.add(key(pl.name));
          }
        }
      }

      for (const name of this.playerNames) {
        const k = key(name);
        if (this.playerMap[k]) continue;
        if (me && mine.has(k)) {
          this.playerMap[k] = {
            kind: "buddy",
            userId: me.id,
            label: me.display_name || me.username || name,
          };
          continue;
        }
        const self = window.BgbNameMatch.best(name, meRow, BggPlayImport.namesOf);
        if (self) {
          this.playerMap[k] = { kind: "buddy", userId: self.user_id, label: self.name || name };
          continue;
        }
        const account = window.BgbNameMatch.best(name, accounts, BggPlayImport.namesOf);
        if (account) {
          this.playerMap[k] = { kind: "buddy", userId: account.user_id, label: account.name || name };
          continue;
        }
        const ghost = window.BgbNameMatch.best(name, ghosts, BggPlayImport.namesOf);
        this.playerMap[k] = {
          kind: "ghost",
          userId: null,
          // Matching an existing ghost adopts ITS spelling, so the import
          // lands on the same player rather than creating a near-duplicate.
          label: ghost ? (ghost.name || name) : name,
        };
      }
    }

    /** The names a candidate can be recognised by, best evidence first. */
    static namesOf(candidate) { return [candidate.name, candidate.username]; }

    /** @param {string} name @param {any} mapping */
    setPlayer(name, mapping) { this.playerMap[key(name)] = mapping; }

    /** @param {string} name */
    playerMapping(name) {
      return this.playerMap[key(name)] || { kind: "ghost", userId: null, label: name };
    }

    // ── Game mapping ─────────────────────────────────────────────────────────

    /** @param {number|string} bggGameId @param {any|null} game */
    setGame(bggGameId, game) {
      this.gameMap[String(bggGameId)] = game
        ? { id: game.id, name: game.name, thumbnail_url: game.thumbnail_url || null }
        : null;
    }

    /** @param {number|string} bggGameId */
    gameMapping(bggGameId) { return this.gameMap[String(bggGameId)] || null; }

    /** @param {BggDraftPlay} play */
    playGame(play) { return this.gameMapping(play.bggGameId); }

    /**
     * BGG games the catalog still lacks, and how many live plays each costs.
     * The rows of the Games step.
     */
    unresolvedGames() {
      const out = [];
      const byId = new Map();
      for (const p of this.plays) {
        if (p.dropped || this.playGame(p)) continue;
        let row = byId.get(p.bggGameId);
        if (!row) {
          row = { bggId: p.bggGameId, name: p.bggGameName, plays: 0 };
          byId.set(p.bggGameId, row);
          out.push(row);
        }
        row.plays++;
      }
      return out;
    }

    // ── The review list ──────────────────────────────────────────────────────

    /** Live plays, grouped into the review list's per-game subsections. */
    groups() {
      const out = [];
      const byKey = new Map();
      for (const play of this.plays) {
        if (play.dropped) continue;
        const game = this.playGame(play);
        const k = game ? `id:${game.id}` : `bgg:${play.bggGameId}`;
        let group = byKey.get(k);
        if (!group) {
          group = { key: k, name: game ? game.name : play.bggGameName, game, plays: [] };
          byKey.set(k, group);
          out.push(group);
        }
        group.plays.push(play);
      }
      return out;
    }

    /**
     * One group's plays as review rows: everything indistinguishable collapses
     * into a single row carrying all of it — the same identity the feed groups
     * on, so the row the user reviews and the card they will see cannot
     * disagree.
     * @param {BggDraftPlay[]} plays
     */
    rows(plays) {
      const out = [];
      const byKey = new Map();
      for (const play of plays || []) {
        const k = this.rowKeyFor(play);
        let row = byKey.get(k);
        if (!row) {
          row = { key: k, runId: null, plays: [] };
          byKey.set(k, row);
          out.push(row);
        }
        row.plays.push(play);
      }
      return out;
    }

    /**
     * What a reader would use to tell two plays apart, after everything the
     * user has resolved. Seats are sorted, so seating order is not part of the
     * identity.
     *
     * Deliberately does NOT include bggPlayId. Two BGG plays that agree on the
     * game, the day, the note and the whole table are indistinguishable to
     * anybody reading the log, which is exactly what one stacked card is for —
     * and each still lands as its own row carrying its own id.
     * @param {BggDraftPlay} play
     */
    rowKeyFor(play) {
      const game = this.playGame(play);
      const seats = this.seats(play).map((s) => this.seatKey(s)).sort();
      return [
        game ? `id:${game.id}` : `bgg:${play.bggGameId}`,
        this.dateFor(play),
        play.notes || "",
        seats.join(","),
      ].join("|");
    }

    /**
     * The seats of one play, as they will be written: resolved through the
     * Players step and collapsed wherever two BGG spellings turned out to be
     * one person. Everything downstream reads THIS, not play.players.
     * @param {BggDraftPlay} play
     */
    seats(play) {
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
     * Merge seats that are the same person, whatever they were called — the
     * collapse point for migration 023's uq_bgb_play_players_play_user. The
     * winner flag ORs and the first non-null score wins.
     * @param {any[]} seats
     */
    _collapse(seats) {
      const out = [];
      const byWho = new Map();
      for (const seat of seats || []) {
        if (!seat) continue;
        if (!seat.user_id && !key(seat.name)) continue;
        const who = BggPlayImport.whoOf(seat);
        const taken = byWho.get(who);
        if (taken) {
          taken.is_winner = taken.is_winner || !!seat.is_winner;
          if (taken.score == null && (seat.score === 0 || seat.score)) taken.score = seat.score;
          continue;
        }
        const next = {
          name: seat.name,
          is_winner: !!seat.is_winner,
          score: (seat.score === 0 || seat.score) ? seat.score : null,
          user_id: seat.user_id || null,
        };
        byWho.set(who, next);
        out.push(next);
      }
      return out;
    }

    /** WHO a seat is, with nothing about how this play went. */
    static whoOf(seat) {
      return seat.user_id ? `u:${seat.user_id}` : `g:${key(seat.name)}`;
    }

    /** One written seat's identity, for the row and group keys. */
    seatKey(seat) {
      return `${BggPlayImport.whoOf(seat)}#${seat.is_winner ? "w" : ""}`
           + `#${seat.score == null ? "" : seat.score}`;
    }

    /** @param {string} playId */
    rowFor(playId) {
      for (const group of this.groups()) {
        for (const row of this.rows(group.plays)) {
          if (row.plays.some((p) => p.id === playId)) return row;
        }
      }
      return null;
    }

    /** @param {BggDraftPlay} play BGG never hands over a dateless play. */
    dateFor(play) { return play.playedAt; }

    get liveCount() { return this.plays.filter((p) => !p.dropped).length; }

    /** Plays that will actually be written — live, with a game, with a table. */
    importable() {
      return this.plays.filter(
        (p) => !p.dropped && !!this.playGame(p) && this.seats(p).length > 0,
      );
    }

    /** Live plays whose game resolved but whose table is empty. */
    seatless() {
      return this.plays.filter(
        (p) => !p.dropped && !!this.playGame(p) && this.seats(p).length === 0,
      );
    }

    dropPlays(ids) {
      const set = new Set(ids);
      for (const p of this.plays) if (set.has(p.id)) p.dropped = true;
    }

    // ── The shared review adapter ────────────────────────────────────────────

    /** @returns {"bgg"} */
    get sourceKey() { return "bgg"; }

    /** Every BGG play carries its own date; there is nothing to bulk-set. */
    get supportsBulkDate() { return false; }

    /**
     * The catalog game of one item in `importable()`. Part of the ImportSource
     * interface — see PlayImport.gameOf. A BGG play resolves through the game
     * map, keyed by BoardGameGeek's own id.
     * @param {BggDraftPlay} play
     */
    gameOf(play) { return this.playGame(play); }

    /** The picker's Resume row, in this source's own words. */
    resumeLabel() {
      const n = this.liveCount;
      return `${n} BoardGameGeek play${n === 1 ? "" : "s"} you were still reviewing`;
    }

    /**
     * What this source knows it is not telling the whole truth about. Both are
     * facts about BoardGameGeek rather than anything that went wrong, so they
     * are warnings on the review rather than errors on the way in.
     */
    reviewWarnings() {
      const out = [];
      if (this.truncated) {
        out.push(
          `You have ${this.totalNew} plays on BoardGameGeek that aren't here yet — `
          + `these are the newest ${this.plays.length}. Run this again afterwards `
          + `for the rest; the ones you import won't come back.`,
        );
      }
      const repeats = this.plays.filter((p) => !p.dropped && p.quantity > 1);
      if (repeats.length) {
        const total = repeats.reduce((n, p) => n + p.quantity, 0);
        out.push(
          `${repeats.length} of these ${repeats.length === 1 ? "is" : "are"} recorded on `
          + `BoardGameGeek as standing for several sittings (${total} in all). `
          + `${repeats.length === 1 ? "It comes" : "They come"} over as one play each — `
          + `BoardGameGeek only gives one record to split.`,
        );
      }
      return out;
    }

    /** The review list. `rows` is the only shape the shared step renders. */
    reviewGroups() {
      return this.groups().map((group) => ({
        key: group.key,
        name: group.name,
        game: group.game,
        rows: this.rows(group.plays).map((row) => this._reviewRow(row)),
      }));
    }

    /** @param {{plays: BggDraftPlay[]}} row */
    _reviewRow(row) {
      const first = row.plays[0];
      const n = row.plays.length;
      return {
        id: first.id,
        count: n,
        // Never a control: a cloned play would have no BoardGameGeek id of its
        // own, and every row here stands for a record on somebody else's
        // server rather than a tally somebody wrote down.
        countEditable: false,
        game: this.playGame(first),
        playedAt: this.dateFor(first),
        notes: first.notes || null,
        thumbUrl: null,
        countryCode: null,
        seats: this.seats(first),
        edited: !!first.seatsOverride,
        runNote: n > 1
          ? `BoardGameGeek has ${n} of these — same game, same day, same players.`
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
     * different fixes.
     */
    reviewNotices() {
      const seatless = this.seatless().length;
      const gameless = this.liveCount - this.importable().length - seatless;
      const out = [];
      if (gameless) {
        out.push({
          count: gameless,
          text: `${gameless} play${gameless === 1 ? "" : "s"} won't be imported — `
              + `BoardgameBuddy doesn't have ${gameless === 1 ? "that game" : "those games"} `
              + `yet. Go back to Games to bring ${gameless === 1 ? "it" : "them"} over `
              + `from BoardGameGeek.`,
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

    /** A line under the CTA — the one promise this source can make. */
    ctaNote() {
      return "These land with their BoardGameGeek play ids, so importing again "
           + "won't offer you the same plays twice.";
    }

    /** @param {any} p @param {boolean} busy */
    progressHeading(p, busy) {
      return busy ? "Importing…" : (p && p.failed ? "Import finished" : "Imported");
    }

    progressNote() { return null; }

    // ── Row edits the shared review drives ───────────────────────────────────
    //
    // Every edit applies to the WHOLE ROW, which is the established semantics
    // of this screen across all three sources. An identical change to N plays
    // produces N identical new keys, so the row survives as one row of N — and
    // two rows can MERGE when an edit makes their keys equal, which the host
    // re-anchors around.

    /** @param {string} playId @param {any} game */
    setRowGame(playId, game) {
      const row = this.rowFor(playId);
      if (!row || !game) return false;
      // Keyed by BGG game id, so this resolves every play of that game at once
      // — which is what the user means, and what stops the Games step
      // disagreeing with a row they just fixed.
      for (const play of row.plays) this.setGame(play.bggGameId, game);
      return true;
    }

    /** @param {string} playId @param {string} iso */
    setRowDate(playId, iso) {
      const row = this.rowFor(playId);
      if (!row || !iso) return false;
      for (const play of row.plays) play.playedAt = iso;
      return true;
    }

    /**
     * Resizing is not offered for this source — see _reviewRow. Declared so the
     * ImportSource contract is answered by a deliberate refusal rather than by
     * a missing method.
     */
    setRowCount() { return false; }

    /** @param {string} playId */
    dropRow(playId) {
      const row = this.rowFor(playId);
      if (!row) return false;
      this.dropPlays(row.plays.map((p) => p.id));
      return true;
    }

    // ── Per-play seat editing ────────────────────────────────────────────────

    /** @param {BggDraftPlay} play */
    _materialise(play) {
      if (!play.seatsOverride) play.seatsOverride = this.seats(play);
      return play.seatsOverride;
    }

    /** @param {string} playId @param {(seats: any[]) => any[]|void} fn */
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
        (seats) => seats.filter((s) => BggPlayImport.whoOf(s) !== who));
    }

    /** Several winners is a tie, so this toggles one seat. */
    toggleWinner(playId, who) {
      return this._editRow(playId, (seats) => seats.map((s) => (
        BggPlayImport.whoOf(s) === who ? { ...s, is_winner: !s.is_winner } : s
      )));
    }

    /**
     * One final score for one seat. BoardGameGeek's /plays carries no scores at
     * all, so every one of these is the user adding something the source never
     * had — which is why it is offered even though the import is a copy.
     */
    setScore(playId, who, value) {
      const raw = String(value == null ? "" : value).trim();
      const score = raw === "" ? null : Math.trunc(Number(raw));
      if (score != null && !Number.isFinite(score)) return false;
      return this._editRow(playId, (seats) => seats.map((s) => (
        BggPlayImport.whoOf(s) === who ? { ...s, score } : s
      )));
    }

    // ── The write ────────────────────────────────────────────────────────────

    /** @param {BggDraftPlay} play */
    groupKeyFor(play) {
      if (!this.playGame(play)) return null;
      return this.rowKeyFor(play);
    }

    /**
     * Mint one group id per key covering MORE THAN ONE play. A lone play is
     * never tagged, so it gets an ordinary polaroid rather than a "1 plays"
     * stack card.
     * @param {BggDraftPlay[]} plays
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

    /** One draft play as the PlayCreate body the API takes. */
    toPayload(play, groups, batchId) {
      const game = this.playGame(play);
      return {
        game_id: game ? game.id : null,
        played_at: this.dateFor(play),
        notes: play.notes || null,
        players: this.seats(play),
        // The draft's own idempotency key, so re-sending a chunk whose response
        // was lost returns duplicates rather than a second set of plays.
        client_key: play.id,
        // Migration 040. The OTHER idempotency key, and the one that spans
        // drafts, devices and the retired POST /bgg/sync write path — those
        // rows carry this and no client_key, so nothing else can see them.
        bgg_play_id: play.bggPlayId,
        import_group_id: (groups && groups.get(play.id)) || null,
        // Migration 007. Every play in THIS import shares one, so a BGG import
        // can be undone from Settings — which it never could when the sync
        // wrote these rows itself.
        import_batch_id: batchId || null,
      };
    }

    /**
     * Write every importable play, a chunk at a time.
     * @param {(p: {done: number, total: number}) => void} onProgress
     */
    async run(onProgress) {
      const plays = this.importable();
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
          // both keys make a repeat free. Past that, stop rather than grind
          // through forty more chunks against a server that is down.
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
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: DRAFT_VERSION,
          step: this.step,
          bggUsername: this.bggUsername,
          plays: this.plays,
          playerNames: this.playerNames,
          playerMap: this.playerMap,
          gameMap: this.gameMap,
          totalNew: this.totalNew,
          truncated: this.truncated,
          fetchedAt: this.fetchedAt,
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
      this.bggUsername = data.bggUsername || null;
      this.plays = (data.plays || []).map((p) => ({
        ...p,
        seatsOverride: p.seatsOverride || null,
      }));
      this.playerNames = data.playerNames || [];
      this.playerMap = data.playerMap || {};
      this.gameMap = data.gameMap || {};
      this.totalNew = data.totalNew || 0;
      this.truncated = !!data.truncated;
      this.fetchedAt = data.fetchedAt || null;
      // Progress is deliberately not restored. A run interrupted mid-write has
      // an unknown outcome from the client's side; the safe resume is to import
      // again and let the two idempotency keys deduplicate.
      this.progress = null;
      return true;
    }

    /** True once there is anything a refresh or a close would lose. */
    get isDirty() { return this.plays.length > 0; }
  }

  window.BggPlayImport = BggPlayImport;
})();
