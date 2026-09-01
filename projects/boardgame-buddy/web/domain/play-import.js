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
//     run survives only as `runId`, which is what lets the review list collapse
//     58 identical rows back into one line.
//
//   • EVERY DRAFT PLAY CARRIES ITS OWN client_key. Stamped at expansion, kept
//     in the saved draft, sent on every attempt. bgb_log_play answers a key it
//     already holds with {duplicate: true}, so re-running a half-finished
//     import lands the rest and re-writes nothing.
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
     * play partners. Exact, then case-insensitive, then a prefix match in
     * either direction — that last one is what offers "Jasmine" for a note
     * that says "Jas". Never applied silently to a name the user has already
     * decided about.
     * @param {{accounts: any[], ghosts: any[]}} partners
     */
    suggestPlayers(partners) {
      const accounts = (partners && partners.accounts) || [];
      const ghosts = (partners && partners.ghosts) || [];
      for (const name of this.playerNames) {
        const k = key(name);
        if (this.playerMap[k]) continue;
        const account = PlayImport._bestMatch(name, accounts, (a) => a.display_name || a.username || "");
        if (account) {
          this.playerMap[k] = {
            kind: "buddy",
            userId: account.user_id || account.id,
            label: account.display_name || account.username || name,
          };
          continue;
        }
        const ghost = PlayImport._bestMatch(name, ghosts, (g) => g.display_name || g.name || "");
        this.playerMap[k] = {
          kind: "ghost",
          userId: null,
          // Matching an existing ghost adopts ITS spelling, so the import
          // lands on the same player rather than creating a near-duplicate.
          label: ghost ? (ghost.display_name || ghost.name || name) : name,
        };
      }
    }

    static _bestMatch(name, rows, nameOf) {
      const k = key(name);
      if (!k) return null;
      let prefix = null;
      for (const row of rows || []) {
        const other = key(nameOf(row));
        if (!other) continue;
        if (other === k) return row;
        // Shorthand only ever shortens, and a one-letter stem matches
        // everybody — "A" must not silently become "Amelia".
        if (!prefix && k.length >= 2 && (other.startsWith(k) || k.startsWith(other))) prefix = row;
      }
      return prefix;
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
     * One group's plays as review rows: a run of identical repeats collapses
     * into a single row carrying all of them, anything else is its own row.
     * Order is preserved, so a run and the detailed plays around it stay where
     * the note put them.
     * @param {DraftPlay[]} plays
     */
    static rows(plays) {
      const out = [];
      let current = null;
      for (const play of plays) {
        if (play.runId && current && current.runId === play.runId) {
          current.plays.push(play);
          continue;
        }
        current = { runId: play.runId, plays: [play] };
        out.push(current);
      }
      return out;
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

    dropPlays(ids) {
      const set = new Set(ids);
      for (const p of this.plays) if (set.has(p.id)) p.dropped = true;
    }

    restorePlays(ids) {
      const set = new Set(ids);
      for (const p of this.plays) if (set.has(p.id)) p.dropped = false;
    }

    // ── The write ────────────────────────────────────────────────────────────

    /** One draft play as the PlayCreate body the API takes. */
    toPayload(play) {
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
      };
    }

    /**
     * Write every importable play, a chunk at a time.
     * @param {(p: {done: number, total: number}) => void} onProgress
     */
    async run(onProgress) {
      const plays = this.importable();
      this.progress = { done: 0, total: plays.length, imported: 0, duplicate: 0, failed: 0, errors: [] };
      for (let i = 0; i < plays.length; i += CHUNK_SIZE) {
        const chunk = plays.slice(i, i + CHUNK_SIZE);
        const body = { plays: chunk.map((p) => this.toPayload(p)) };
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
