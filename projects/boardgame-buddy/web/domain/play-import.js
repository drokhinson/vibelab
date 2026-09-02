// @ts-check
// domain/play-import.js — the play importer's model.
//
// Owns the draft: what was pasted, what the model made of it, how each name
// and each game resolved, and the chunked write at the end. No DOM — the view
// (views/import-plays-view.js) reads this and paints, and the step bodies
// (widgets/import-plays-steps.js) are pure functions of it.
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
  // Mirrors MAX_REPEAT_COUNT — the ceiling the parser already clamps a run to,
  // so hand-editing one cannot get past what the model was allowed to say.
  const MAX_RUN = 300;
  // The parse walks a whole note through a model; 15s is a JSON round trip.
  const PARSE_TIMEOUT_MS = 90000;
  const IMPORT_TIMEOUT_MS = 60000;

  const STEPS = ["source", "details", "players", "games", "plays", "import"];

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
   * @property {boolean} dropped   Kept rather than spliced, so undo is possible
   *   and a run's counts stay stable while the user trims it.
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

    // ── Parse ────────────────────────────────────────────────────────────────

    /** Send the note. Replaces every downstream field — a re-parse starts over. */
    async parse() {
      const res = await window.api.post(
        "/plays/import/parse",
        { text: this.text.slice(0, MAX_CHARS), hint: this.hint.trim().slice(0, MAX_HINT_CHARS) || null },
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
      const seats = play.players.map((p) => this.seatKey(p)).sort();
      return [
        game ? `id:${game.id}` : `name:${key(play.gameName)}`,
        this.dateFor(play),
        play.notes || "",
        seats.join(","),
      ].join("|");
    }

    /**
     * One seat's identity. The ACCOUNT when the name resolved to one, so two
     * spellings of one buddy are one seat; the resolved ghost label otherwise,
     * so two spellings kept as one ghost are too. Never the name the note
     * wrote — that is the thing this step exists to translate.
     * @param {DraftPlayer} player
     */
    seatKey(player) {
      const m = this.playerMapping(player.name);
      const who = m.userId ? `u:${m.userId}` : `g:${key(m.label || player.name)}`;
      return `${who}#${player.isWinner ? "w" : ""}#${player.score == null ? "" : player.score}`;
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

    /** Plays that will actually be written — live, and with a resolved game. */
    importable() {
      return this.plays.filter((p) => !p.dropped && !!this.playGame(p));
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

    restorePlays(ids) {
      const set = new Set(ids);
      for (const p of this.plays) if (set.has(p.id)) p.dropped = false;
    }

    // ── The write ────────────────────────────────────────────────────────────

    /**
     * The identity of a play for FEED grouping, or null when it has something
     * of its own to say.
     *
     * A score on any seat or a note is disqualifying: those are exactly the
     * plays a reader wants to see individually — the biggest win, the closest
     * game, the one with a comment. Everything else is identified by what a
     * reader would use to tell two plays apart: the game, the day, who was
     * there, and who won.
     *
     * Deliberately NOT play.runId. The run id says "the model wrote these as
     * one line"; this says "these are indistinguishable". The second is the
     * claim the collapsed card actually makes, and it survives the model
     * splitting a run across entries or lumping a scored play into one.
     * @param {DraftPlay} play
     * @returns {string|null}
     */
    groupKeyFor(play) {
      if (play.notes) return null;
      if (play.players.some((p) => p.score === 0 || p.score)) return null;
      if (!this.playGame(play)) return null;
      // The review row's identity, unchanged. With no note and no scores, what
      // rowKeyFor holds IS the game, the day, who was there and who won — and
      // sharing it is the point: a row the user reviewed as one play must not
      // arrive in the feed as several, nor two rows as one.
      return this.rowKeyFor(play);
    }

    /**
     * Mint one group id per key that covers MORE THAN ONE play, and hand back
     * a play-id → group-id map.
     *
     * The "more than one" is the whole point: a lone winner-only play is not a
     * run, and tagging it would put a "1 plays" stack card in the feed where an
     * ordinary polaroid belongs.
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
        players: play.players.map((pl) => {
          const mapping = this.playerMapping(pl.name);
          return {
            name: mapping.label || pl.name,
            is_winner: !!pl.isWinner,
            score: (pl.score === 0 || pl.score) ? pl.score : null,
            user_id: mapping.kind === "buddy" ? mapping.userId : null,
          };
        }),
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
      this.hint = String(data.hint || "");
      this.plays = data.plays;
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
    get isDirty() { return !!(this.text.trim() || this.plays.length); }
  }

  window.PlayImport = PlayImport;
})();
