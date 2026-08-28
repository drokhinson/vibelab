// domain/play-session.js — Local + remote play-session state.
//
// Two responsibilities:
//   1. Local in-progress draft (game, players, photo) persisted to
//      localStorage so a refresh doesn't lose work. The photo blob stays in
//      memory only; on reload we surface a "re-attach photo" affordance.
//   2. Optional short-code "join from another phone" lobby, backed by the
//      /sessions endpoints. When `code` is set the participant list is
//      polled every 2s while the LogPlayView is mounted.

(function () {
  const LS_KEY = "bgb_play_session_v1";

  // ── Lobby prefetch channel ─────────────────────────────────────────────────
  //
  // POST /sessions used to fire from PlayFlowView.onMount, i.e. only after the
  // router had swapped views and the Gather screen had painted — so the invite
  // card sat on its "— — — — —" placeholder for a whole round trip. The mint
  // is now kicked off in the tap handler instead and parked here; the record
  // outlives the view swap because producer (chooser) and consumer (play flow)
  // are different views.
  //
  // Module-level and single-slot on purpose: a host may only ever have one
  // open session (bgb_create_session abandons their others), so holding two
  // would mean the second silently killed the first.
  let _prefetch = null;   // { promise, gameId, startedAt }
  // Past this, assume the user wandered off and the lobby is stale enough that
  // minting fresh is safer than adopting it.
  const PREFETCH_MAX_AGE_MS = 30 * 1000;

  class PlaySession {
    constructor(initial = {}) {
      this.gameId       = initial.gameId || null;
      this.gameSnapshot = initial.gameSnapshot || null; // {id,name,thumbnail_url,...}
      this.playedAt     = initial.playedAt || new Date().toISOString().slice(0, 10);
      this.players      = initial.players || [];
      this.notes        = initial.notes || "";
      this.expansionIds = initial.expansionIds || [];
      this.playMode     = initial.playMode || null;
      this.code         = initial.code || null;
      this.sessionId    = initial.sessionId || null;
      this.hostUserId   = initial.hostUserId || null;
      // Cascade screen the host is currently on. Mirrors the backend
      // `phase` column so a refresh resumes on the same screen.
      this.phase        = initial.phase || "gather";
      this.photoBlob    = null; // in-memory only — never persisted
      this.photoUrl     = initial.photoUrl || null;
      // Closed out by clear(). In-memory only, and never read from `initial`:
      // a done draft is never persisted, so a loaded one is always live.
      this._done        = false;
    }

    static load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return new PlaySession(parsed);
      } catch (_) {
        return null;
      }
    }

    persist() {
      // A closed-out draft never goes back to disk. clear() is not the end of
      // this object's life — the view keeps holding it, and ~30 persist() call
      // sites can still fire against it — so without this, one late write
      // re-creates the key and the Play tab offers to resume a finished game.
      // That is exactly how a saved play used to come back: a poll tick 404s on
      // the finalized session, _healLobby persists to drop the dead code, then
      // _ensureLobbyOpen mints a fresh lobby and persists the new one.
      if (this._done) return;
      const snapshot = {
        gameId: this.gameId,
        gameSnapshot: this.gameSnapshot,
        playedAt: this.playedAt,
        players: this.players,
        notes: this.notes,
        expansionIds: this.expansionIds,
        playMode: this.playMode,
        code: this.code,
        sessionId: this.sessionId,
        hostUserId: this.hostUserId,
        phase: this.phase,
        photoUrl: this.photoUrl,
      };
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch (_) {}
    }

    /**
     * Drop the on-disk copy WITHOUT touching the in-memory draft.
     *
     * Save is the one moment the two have to diverge. The host commits, the
     * wrap-up card goes up dismissible, and they can be back on the Play tab
     * before the write lands — where LogPlayView._resumableSession() reads this
     * key and would offer to resume the game they just saved (the draft's phase
     * at Save time is `settle`, not `finalized`). So the disk copy retires at
     * the tap; the in-memory draft lives until the write settles, because a
     * failure still has to leave a complete Settle Up behind the card.
     */
    unpersist() {
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
    }

    clear() {
      this.gameId = null;
      this.gameSnapshot = null;
      this.players = [];
      this.notes = "";
      this.expansionIds = [];
      this.playMode = null;
      this.code = null;
      this.sessionId = null;
      this.hostUserId = null;
      // Terminal, not "gather". Two guards read this and both were dead before:
      // LogPlayView._resumableSession()'s `phase !== "finalized"` test (nothing
      // in the client ever wrote that value), and PlayFlowView's Gather-only
      // poll gate — which resetting to "gather" actively re-OPENED, turning the
      // clear into the trigger for the resurrection it was meant to prevent.
      this.phase = "finalized";
      this._done = true;
      this.photoBlob = null;
      this.photoUrl = null;
      if (this.photoPreviewUrl) {
        try { URL.revokeObjectURL(this.photoPreviewUrl); } catch (_) {}
      }
      this.photoFile = null;
      this.photoPreviewUrl = null;
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
    }

    isActive() {
      return !!(this.gameId || this.players.length || this.code);
    }

    /**
     * Has this draft been closed out?
     *
     * Deliberately in-memory only — it is not part of the persisted snapshot,
     * because a done draft is never written, so load() can never see one. Every
     * legitimate re-seed builds a NEW PlaySession (onMount, _startAnotherRound,
     * LogPlayView._anotherRound, JoinPanel), so the flag never outstays the run
     * it belongs to.
     *
     * @returns {boolean}
     */
    isDone() {
      return !!this._done;
    }

    /**
     * Build a fresh-draft seed from a play-history row (profile bundle
     * `recent_plays[]`, or a row from GET /plays) so the same group can play
     * the same game again. Mirrors PlayFlowView._nextRoundSeed(): the game
     * and the roster carry over, the results do not, and no participant_id
     * comes along — those belong to the finished lobby.
     *
     * The play row has no rulebook_url / is_expansion, so callers that can
     * cheaply resolve the game (e.g. a warmed "game.bundle" cache entry) pass
     * it as `gameExtras`; absent it the guide link just stays unset until the
     * host flow loads the game itself.
     */
    static seedFromPlayRow(row, gameExtras = {}) {
      if (!row || !row.game_id) return null;
      const g = gameExtras || {};
      return {
        gameId: row.game_id,
        gameSnapshot: {
          id: row.game_id,
          name: row.game_name || g.name || "",
          thumbnail_url: row.game_thumbnail || g.thumbnail_url || null,
          rulebook_url: g.rulebook_url || null,
          is_expansion: !!g.is_expansion,
        },
        expansionIds: (row.expansions || [])
          .map((e) => e.expansion_game_id)
          .filter(Boolean),
        playMode: row.play_mode || g.play_mode || null,
        players: (row.players || []).map((p) => ({
          name: p.name,
          user_id: p.user_id || null,
          avatar: p.avatar || null,
          is_winner: false,
          score: null,
          team: "",
          initials: null,
        })),
      };
    }

    // Remote lobby helpers ──────────────────────────────────────────────────────

    static async openLobby({ gameId } = {}) {
      const session = await window.api.post("/sessions", { game_id: gameId || null });
      return session;
    }

    /**
     * Start minting a lobby NOW, before the user has navigated. Call from the
     * tap handler; PlayFlowView consumes it in _ensureLobbyOpen().
     *
     * CAUTION: this is a real write. bgb_create_session abandons every other
     * open session this host owns, so never call it while the user has a
     * resumable session — that would close the very lobby they're resuming.
     */
    static prefetchLobby({ gameId = null } = {}) {
      PlaySession.discardPrefetchedLobby();
      const promise = PlaySession.openLobby({ gameId });
      // The consumer may never arrive (user backs out), so own the rejection
      // here — an unhandled one would surface as a console error.
      promise.catch(() => {});
      _prefetch = { promise, gameId, startedAt: Date.now() };
      return promise;
    }

    /**
     * One-shot consume. Returns the in-flight (or settled) promise, or null
     * when there's nothing usable — in which case the caller mints normally.
     * A record past PREFETCH_MAX_AGE_MS is abandoned rather than adopted.
     */
    static takePrefetchedLobby() {
      const rec = _prefetch;
      _prefetch = null;
      if (!rec) return null;
      if (Date.now() - rec.startedAt > PREFETCH_MAX_AGE_MS) {
        _abandonMinted(rec);
        return null;
      }
      return rec.promise;
    }

    /** Drop an unconsumed prefetch and close the lobby it opened. */
    static discardPrefetchedLobby() {
      const rec = _prefetch;
      _prefetch = null;
      if (rec) _abandonMinted(rec);
    }

    static async joinLobby(code, { displayName } = {}) {
      return window.api.post(`/sessions/${code}/join`, {
        display_name: displayName || null,
      });
    }

    static fetchLobby(code) {
      return window.api.get(`/sessions/${code}`);
    }

    // Host-only. Pass `gameId: null` to clear the pick.
    static updateLobby(code, { gameId } = {}) {
      return window.api.patch(`/sessions/${code}`, { game_id: gameId || null });
    }

    // Host-only. Adds a buddy (with userId) or a ghost (userId=null) to the
    // backend participants table so other joiners can see them. Without this
    // call, host-typed players live only in the host's localStorage draft and
    // never reach joiners.
    static addParticipant(code, { userId, displayName }) {
      return window.api.post(`/sessions/${code}/participants`, {
        user_id: userId || null,
        display_name: displayName,
      });
    }

    // Host-only. Remove a participant row by id.
    static removeParticipant(code, participantId) {
      return window.api.del(`/sessions/${code}/participants/${participantId}`);
    }

    // Writes the play the lobby was building. Same cache blast radius as
    // Play.create — profile, stats, game bundle, buddies, feed first page —
    // so it routes through the same invalidation instead of leaving every one
    // of them holding a pre-play view.
    static finalizeLobby(code, payload) {
      return window.api.post(`/sessions/${code}/finalize`, payload)
        .then((r) => { if (window.Play) window.Play.invalidateDeps(); return r; });
    }

    // Host-only. Move the lobby through gather → play → settle, or abandon.
    static advancePhase(code, phase) {
      return window.api.patch(`/sessions/${code}/phase`, { phase });
    }

    // Joinable sessions for the current viewer (drives the Join chooser).
    static listJoinable() {
      return window.api.get("/sessions/joinable");
    }

    // Build the POST /plays body from this draft. Used both for solo logs and
    // for the host's finalize call (which has the same shape). Each player's
    // `score` is the sum of their roundScores when rounds were tracked;
    // `round_scores` is sent only when more than one round exists so the
    // simple-score path (no grid) leaves the column NULL on the backend.
    toPlayCreate() {
      return {
        game_id: this.gameId,
        played_at: this.playedAt,
        players: this.players.map((p) => ({
          name: p.name,
          is_winner: !!p.is_winner,
          score: rollupScore(p),
          user_id: p.user_id || null,
          round_scores: persistableRounds(p),
        })),
        notes: this.notes || null,
        photo_url: this.photoUrl || null,
        expansion_ids: this.expansionIds,
        play_mode: this.playMode || null,
      };
    }
  }

  // Best-effort cleanup of a lobby nobody entered, so it never shows up in a
  // buddy's Join chooser. Belt and braces: even if this fails, the row carries
  // an expires_at and the host's next create abandons it anyway.
  function _abandonMinted(rec) {
    rec.promise
      .then((s) => (s && s.code ? window.api.del(`/sessions/${s.code}`) : null))
      .catch(() => {});
  }

  // A player's recorded total. When rounds were tracked it is the sum of the
  // grid — computed by the same helper the scoring table renders its Total
  // with (widgets/round-score-grid.js), so the number saved to the play is the
  // number the host was looking at when they hit Save.
  function rollupScore(p) {
    const rs = p && p.roundScores;
    if (Array.isArray(rs) && rs.length > 0) {
      return window.roundGridTotal(p, rs.length);
    }
    return p && p.score != null ? p.score : null;
  }

  // Only persist the per-round breakdown when there were more than one
  // round. Single-round / no-round plays stay on the simple-score path
  // and leave the backend column NULL.
  function persistableRounds(p) {
    const rs = p && p.roundScores;
    if (!Array.isArray(rs) || rs.length <= 1) return null;
    // Cells may be sanitized strings ("-5") incl. a transient "-" — coerce to
    // int, treating empty / lone-minus as null. Negative scores persist fine.
    return rs.map((v) => {
      if (v === "" || v === "-" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
  }

  window.PlaySession = PlaySession;
})();
