// domain/live-scores.js — Realtime per-player live scores during Play.
//
// Wraps a Supabase Realtime channel on boardgamebuddy_play_session_scores.
// Writes go straight to the table via the anon key — RLS (migration 026)
// enforces that authed joiners can only touch their own column and the
// host can override anyone's row in their own session.
//
// Lifecycle:
//   const ls = new LiveScores({ sessionId, isHost, currentUserId });
//   await ls.start();        // backfill + subscribe
//   const off = ls.subscribe(() => render());
//   ls.setMyScore(roundIndex, value);              // any joiner
//   ls.setAnyScore(userId, roundIndex, value);     // host only
//   await ls.stop();
//
// Cell lookups are keyed (player_user_id, round_index). Guest joiners
// (no user_id) are NOT represented here; the host types their scores
// locally and they're merged on finalize.

// @ts-check

(function () {
  /**
   * @typedef {Object} ScoreRow
   * @property {string}  session_id
   * @property {string}  player_user_id
   * @property {number}  round_index
   * @property {number?} score
   */

  class LiveScores {
    constructor({ sessionId, isHost, currentUserId }) {
      this.sessionId = sessionId;
      this.isHost = !!isHost;
      this.currentUserId = currentUserId;
      this._channel = null;
      this._listeners = new Set();
      // Map<player_user_id, Map<round_index, score>>
      this._byPlayer = new Map();
    }

    async start() {
      if (!window.supabaseClient || !this.sessionId) return;
      // Initial backfill so the grid renders with last-known cells before
      // the first Realtime event arrives.
      try {
        const { data } = await window.supabaseClient
          .from("boardgamebuddy_play_session_scores")
          .select("session_id, player_user_id, round_index, score")
          .eq("session_id", this.sessionId);
        for (const row of data || []) this._ingest(row);
      } catch (_) {
        // Best-effort; subscription below will catch us up.
      }
      this._channel = window.supabaseClient
        .channel(`scores:${this.sessionId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "boardgamebuddy_play_session_scores",
            filter: `session_id=eq.${this.sessionId}`,
          },
          (payload) => {
            // DELETE events expose the old row; UPDATE/INSERT expose new.
            const row = payload.new && Object.keys(payload.new).length
              ? payload.new
              : payload.old;
            if (!row) return;
            if (payload.eventType === "DELETE") {
              this._forget(row);
            } else {
              this._ingest(row);
            }
            this._emit();
          }
        )
        .subscribe();
      // Notify once after backfill so subscribers can paint initial state.
      this._emit();
    }

    async stop() {
      if (this._channel && window.supabaseClient) {
        try {
          await window.supabaseClient.removeChannel(this._channel);
        } catch (_) {}
      }
      this._channel = null;
      this._listeners.clear();
      this._byPlayer.clear();
    }

    /**
     * Subscribe to any change in the cached score map. Returns an
     * unsubscribe function.
     * @param {() => void} fn
     */
    subscribe(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    }

    getScore(playerUserId, roundIndex) {
      const m = this._byPlayer.get(playerUserId);
      if (!m) return null;
      const v = m.get(roundIndex);
      return v == null ? null : v;
    }

    /**
     * Sum of all round scores for a player (live-scoring path only).
     * Returns 0 for an unknown player.
     */
    totalFor(playerUserId) {
      const m = this._byPlayer.get(playerUserId);
      if (!m) return 0;
      let total = 0;
      for (const v of m.values()) total += Number(v) || 0;
      return total;
    }

    /**
     * Highest round_index seen across all players in this session. Used
     * by the joiner's grid to size its rows without round-count metadata
     * from the host. Returns -1 if nothing has been written yet.
     */
    maxRound() {
      let max = -1;
      for (const m of this._byPlayer.values()) {
        for (const k of m.keys()) {
          if (k > max) max = k;
        }
      }
      return max;
    }

    async setMyScore(roundIndex, value) {
      if (!this.currentUserId) {
        throw new Error("Not signed in");
      }
      return this._upsert(this.currentUserId, roundIndex, value);
    }

    async setAnyScore(playerUserId, roundIndex, value) {
      if (!this.isHost) {
        throw new Error("Only the host can override scores");
      }
      return this._upsert(playerUserId, roundIndex, value);
    }

    async _upsert(playerUserId, roundIndex, value) {
      const numeric =
        value === "" || value == null || Number.isNaN(Number(value))
          ? null
          : Number(value);
      // Optimistic local update so the keyboard input feels instant on a
      // slow network — the Realtime echo will arrive a moment later and
      // overwrite with the same value.
      this._ingest({
        player_user_id: playerUserId,
        round_index: roundIndex,
        score: numeric,
      });
      this._emit();
      const row = {
        session_id: this.sessionId,
        player_user_id: playerUserId,
        round_index: roundIndex,
        score: numeric,
      };
      return window.supabaseClient
        .from("boardgamebuddy_play_session_scores")
        .upsert(row, {
          onConflict: "session_id,player_user_id,round_index",
        });
    }

    _ingest(row) {
      if (!row || !row.player_user_id || row.round_index == null) return;
      let m = this._byPlayer.get(row.player_user_id);
      if (!m) {
        m = new Map();
        this._byPlayer.set(row.player_user_id, m);
      }
      m.set(Number(row.round_index), row.score == null ? null : Number(row.score));
    }

    _forget(row) {
      if (!row || !row.player_user_id) return;
      const m = this._byPlayer.get(row.player_user_id);
      if (m) m.delete(Number(row.round_index));
    }

    _emit() {
      for (const fn of this._listeners) {
        try { fn(); } catch (_) {}
      }
    }
  }

  window.LiveScores = LiveScores;
})();
