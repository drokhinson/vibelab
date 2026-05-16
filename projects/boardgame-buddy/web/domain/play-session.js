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
      this.photoBlob    = null; // in-memory only — never persisted
      this.photoUrl     = initial.photoUrl || null;
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
        photoUrl: this.photoUrl,
      };
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch (_) {}
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
      this.photoBlob = null;
      this.photoUrl = null;
      try { localStorage.removeItem(LS_KEY); } catch (_) {}
    }

    isActive() {
      return !!(this.gameId || this.players.length || this.code);
    }

    // Remote lobby helpers ──────────────────────────────────────────────────────

    static async openLobby({ gameId } = {}) {
      const session = await window.api.post("/sessions", { game_id: gameId || null });
      return session;
    }

    static async joinLobby(code, { displayName } = {}) {
      return window.api.post(`/sessions/${code}/join`, {
        display_name: displayName || null,
      });
    }

    static fetchLobby(code) {
      return window.api.get(`/sessions/${code}`);
    }

    static abandonLobby(code) {
      return window.api.del(`/sessions/${code}`);
    }

    static finalizeLobby(code, payload) {
      return window.api.post(`/sessions/${code}/finalize`, payload);
    }

    // Build the POST /plays body from this draft. Used both for solo logs and
    // for the host's finalize call (which has the same shape).
    toPlayCreate() {
      return {
        game_id: this.gameId,
        played_at: this.playedAt,
        players: this.players.map((p) => ({
          name: p.name,
          is_winner: !!p.is_winner,
          score: p.score ?? null,
          user_id: p.user_id || null,
        })),
        notes: this.notes || null,
        photo_url: this.photoUrl || null,
        expansion_ids: this.expansionIds,
        play_mode: this.playMode || null,
      };
    }
  }

  window.PlaySession = PlaySession;
})();
