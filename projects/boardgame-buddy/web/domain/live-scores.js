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
//   ls.removeRoundAt(roundIndex);                  // host only
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
      // Optimistic writes that haven't been confirmed by the table yet, keyed
      // "<player>|<round>". refresh() rebuilds _byPlayer from what the table
      // returns, so without this an in-flight keystroke would blink back to
      // its old value on the next poll tick.
      this._pending = new Map();
    }

    async start() {
      if (!window.supabaseClient || !this.sessionId) return;
      // Initial backfill so the grid renders with last-known cells before
      // the first Realtime event arrives.
      await this.refresh();
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
      this._pending.clear();
    }

    /**
     * Re-read the whole scores table for this session and re-ingest it, then
     * notify subscribers. Used both for the initial backfill (start) and as a
     * Realtime fallback: the joiner calls this on its poll tick so a row the
     * host wrote while Realtime was asleep (e.g. a new round) still surfaces.
     */
    async refresh() {
      if (!window.supabaseClient || !this.sessionId) return;
      try {
        const { data, error } = await window.supabaseClient
          .from("boardgamebuddy_play_session_scores")
          .select("session_id, player_user_id, round_index, score")
          .eq("session_id", this.sessionId);
        // A failed read leaves the cached map alone — better a slightly stale
        // grid than an empty one.
        if (error) throw error;
        // REPLACE the map rather than merging into it. Merging meant a row the
        // host deleted (a removed round) lived on in the cache forever, so
        // totalFor() and maxRound() kept counting a round that was no longer
        // on anyone's grid.
        const next = new Map();
        for (const row of data || []) this._ingestInto(next, row);
        // Re-apply writes still in flight — the table hasn't seen them yet.
        for (const [key, score] of this._pending) {
          const sep = key.lastIndexOf("|");
          this._ingestInto(next, {
            player_user_id: key.slice(0, sep),
            round_index: Number(key.slice(sep + 1)),
            score,
          });
        }
        this._byPlayer = next;
      } catch (_) {
        // Best-effort; the Realtime subscription will catch us up otherwise.
      }
      this._emit();
    }

    /**
     * Host-only. Remove a round: drop every score row at `roundIndex` and pull
     * the rounds after it down one slot, mirroring the Array.splice the host
     * just did to its local roundScores.
     *
     * Deleting the index without shifting was a silent data corruption: rows
     * stayed keyed to their original round_index while the grid re-numbered
     * around the gap, so every cell below the removed round rendered the
     * round above it — and the Total, being the sum of those cells, went with
     * them. The joiner's mirror (which sizes itself from the highest
     * round_index it has seen) kept a phantom trailing round too.
     *
     * @param {number} roundIndex
     */
    async removeRoundAt(roundIndex) {
      if (!this.isHost) throw new Error("Only the host can remove a round");
      const idx = Number(roundIndex);
      if (!Number.isFinite(idx) || idx < 0) return;
      // Shift locally first so maxRound() and every total update immediately,
      // then reconcile the table.
      for (const [playerId, m] of this._byPlayer) {
        const shifted = new Map();
        for (const [r, v] of m) {
          if (r === idx) continue;
          shifted.set(r > idx ? r - 1 : r, v);
        }
        this._byPlayer.set(playerId, shifted);
      }
      // Pending writes are re-applied by refresh(), so they need the same
      // shift or they'd resurrect the pre-removal numbering.
      const pending = new Map();
      for (const [key, score] of this._pending) {
        const sep = key.lastIndexOf("|");
        const r = Number(key.slice(sep + 1));
        if (r === idx) continue;
        pending.set(`${key.slice(0, sep)}|${r > idx ? r - 1 : r}`, score);
      }
      this._pending = pending;
      this._emit();
      if (!window.supabaseClient || !this.sessionId) return;
      try {
        // Delete the whole tail and rewrite it from the shifted map. A
        // per-row UPDATE ladder would collide with the
        // (session_id, player_user_id, round_index) unique index partway
        // through; dropping the tail first cannot.
        const from = () =>
          window.supabaseClient.from("boardgamebuddy_play_session_scores");
        await from()
          .delete()
          .eq("session_id", this.sessionId)
          .gte("round_index", idx);
        const rows = [];
        for (const [playerId, m] of this._byPlayer) {
          for (const [r, score] of m) {
            if (r < idx) continue;
            rows.push({
              session_id: this.sessionId,
              player_user_id: playerId,
              round_index: r,
              score: score == null ? null : score,
            });
          }
        }
        if (rows.length) {
          await from().upsert(rows, {
            onConflict: "session_id,player_user_id,round_index",
          });
        }
      } catch (_) {
        // Best-effort; the next refresh() re-reads the table wholesale.
      }
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
     * Sum of a player's round scores (live-scoring path only). Returns 0 for
     * an unknown player.
     *
     * Pass `roundCount` wherever the number is shown next to a grid: rounds at
     * or beyond it aren't on screen, and summing them is how a total ends up
     * larger than the cells above it. Callers rendering the shared grid should
     * prefer window.roundGridTotal(), which sums the painted cells directly.
     *
     * @param {string} playerUserId
     * @param {number} [roundCount] when given, only rounds [0, roundCount) count.
     */
    totalFor(playerUserId, roundCount) {
      const m = this._byPlayer.get(playerUserId);
      if (!m) return 0;
      const n = roundCount == null ? null : Number(roundCount);
      let total = 0;
      for (const [r, v] of m) {
        if (n != null && (r < 0 || r >= n)) continue;
        total += Number(v) || 0;
      }
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
      const key = `${playerUserId}|${Number(roundIndex)}`;
      this._pending.set(key, numeric);
      this._emit();
      const row = {
        session_id: this.sessionId,
        player_user_id: playerUserId,
        round_index: roundIndex,
        score: numeric,
      };
      const settle = () => {
        // Only clear if this is still the newest write for the cell — a later
        // keystroke has already replaced the entry and owns it now.
        if (this._pending.get(key) === numeric) this._pending.delete(key);
      };
      return window.supabaseClient
        .from("boardgamebuddy_play_session_scores")
        .upsert(row, {
          onConflict: "session_id,player_user_id,round_index",
        })
        .then(
          (res) => { settle(); return res; },
          (err) => { settle(); throw err; }
        );
    }

    _ingest(row) {
      this._ingestInto(this._byPlayer, row);
    }

    // Same ingest, into a caller-supplied map — refresh() builds a fresh one
    // so a wholesale re-read drops rows that no longer exist in the table.
    _ingestInto(byPlayer, row) {
      if (!row || !row.player_user_id || row.round_index == null) return;
      let m = byPlayer.get(row.player_user_id);
      if (!m) {
        m = new Map();
        byPlayer.set(row.player_user_id, m);
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
