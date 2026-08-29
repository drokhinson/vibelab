// domain/live-scores.js — Realtime per-player live scores during Play.
//
// Wraps a Supabase Realtime channel on boardgamebuddy_play_session_scores.
// The host's browser writes straight to the table via the anon key and
// everybody else reads — RLS (migration 053) enforces that only the host of
// the session can write, and only while phase='play'.
//
// Lifecycle:
//   const ls = new LiveScores({ sessionId, isHost });
//   await ls.start();                                  // backfill + subscribe
//   const off = ls.subscribe(() => render());
//   ls.setAnyScore(participantId, roundIndex, value);   // host only
//   ls.syncGrid(players);                               // host only
//   ls.removeRoundAt(roundIndex);                       // host only
//   await ls.stop();
//
// Cell lookups are keyed (participant_id, round_index) — the roster row, not
// the account. That is what lets a GUEST's column stream: a guest has a
// participant row like anyone else but no user_id, so a user-keyed table
// could never carry their scores and spectators watched their column sit
// empty all game.

// @ts-check

(function () {
  /**
   * @typedef {Object} ScoreRow
   * @property {string}  session_id
   * @property {string}  participant_id
   * @property {number}  round_index
   * @property {number?} score
   */

  class LiveScores {
    constructor({ sessionId, isHost }) {
      this.sessionId = sessionId;
      this.isHost = !!isHost;
      this._channel = null;
      this._listeners = new Set();
      // Map<participant_id, Map<round_index, score>>
      this._byPlayer = new Map();
      // Server-rendered copy of the same table, handed to us by the session
      // bundle (see seed()). Kept separately so refresh() can fall back to it
      // rather than overwrite it.
      this._seed = new Map();
      // Has a direct table read ever returned rows? For a spectator who joined
      // after Gather the answer is permanently no — they have no participant
      // row, so bgb_session_scores_select filters everything out — and the
      // seed is the only copy of the grid they will ever get.
      this._tableReadable = false;
      // Host-only ordered writer. Owns every local edit that the table has not
      // yet been observed to agree with, keyed "<participant>|<round>".
      // refresh() rebuilds _byPlayer from what the table returns, so without
      // this an in-flight keystroke would blink back to its old value on the
      // next poll tick — and the Realtime handler consults it so a stale echo
      // can't overwrite a newer local value. See domain/score-write-queue.js.
      this._writes = new window.ScoreWriteQueue((rows) => this._sendRows(rows));
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
            const key = this._writes.keyFor(row.participant_id, row.round_index);
            if (payload.eventType === "DELETE") {
              // A delete for a cell we hold an unconfirmed value for is the
              // echo of our own removeRoundAt tail-drop, not news.
              if (!this._writes.intentFor(key)) this._forget(row);
            } else if (this._writes.accept(key, row.score)) {
              this._ingest(row);
            }
            // Emit even when the row was ignored: the repaint is idempotent,
            // and session-viewer-view stamps its "Realtime is alive" timestamp
            // off this callback to stand the poll fallback down.
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
      this._seed.clear();
      this._tableReadable = false;
      this._writes.clear();
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
          .select("session_id, participant_id, round_index, score")
          .eq("session_id", this.sessionId);
        // A failed read leaves the cached map alone — better a slightly stale
        // grid than an empty one.
        if (error) throw error;
        // REPLACE the map rather than merging into it. Merging meant a row the
        // host deleted (a removed round) lived on in the cache forever, so
        // totalFor() and maxRound() kept counting a round that was no longer
        // on anyone's grid.
        const rows = data || [];
        if (rows.length) this._tableReadable = true;
        // Zero rows is ambiguous: either nobody has scored yet, or RLS is
        // filtering the whole table out from under a late spectator. Fall back
        // to the bundle's copy — which is empty too in the first case, so the
        // two are indistinguishable exactly when it doesn't matter.
        //
        // Once a read HAS returned rows the ambiguity is gone: this client can
        // see the table, so an empty read means the host cleared it and the
        // seed (which is at best one poll behind) must not resurrect what they
        // just removed.
        const authoritative = rows.length > 0 || this._tableReadable;
        const next = authoritative ? new Map() : this._cloneSeed();
        for (const row of rows) {
          // A re-read is as good a confirmation as a Realtime echo: if the
          // table now holds what we asked for, the intent has done its job.
          this._writes.accept(
            this._writes.keyFor(row.participant_id, row.round_index), row.score);
          this._ingestInto(next, row);
        }
        // Re-apply writes still unconfirmed — the table hasn't caught up yet.
        for (const [key, score] of this._writes.entries()) {
          const sep = key.lastIndexOf("|");
          this._ingestInto(next, {
            participant_id: key.slice(0, sep),
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
     * Fold in the server's copy of this session's scores, as carried by the
     * session bundle (`GET /sessions/{code}` → `scores`, migration 054).
     *
     * This is the only path that reaches a spectator who joined after Gather:
     * they hold no participant row, so `bgb_session_scores_select` hides the
     * whole table from their anon-key client — refresh() reads zero rows and
     * Realtime never fires — and without this their mirror would sit on an
     * empty grid for the entire game. Everyone else reads the table directly
     * and the seed is ignored from the first successful read onward.
     *
     * @param {Array<ScoreRow>} rows
     */
    seed(rows) {
      const next = new Map();
      for (const row of rows || []) this._ingestInto(next, row);
      this._seed = next;
      if (this._tableReadable) return;
      // Table's invisible to us: the seed IS the grid. Pending writes can't
      // exist here (spectators never write), but re-apply them anyway so the
      // rule "in-flight writes survive a re-read" holds on every path.
      const merged = this._cloneSeed();
      for (const [key, score] of this._writes.entries()) {
        const sep = key.lastIndexOf("|");
        this._ingestInto(merged, {
          participant_id: key.slice(0, sep),
          round_index: Number(key.slice(sep + 1)),
          score,
        });
      }
      this._byPlayer = merged;
      this._emit();
    }

    /**
     * True while the only copy of the grid we hold came from a seed. That is
     * the late-spectator case, and it means Realtime will never fire for this
     * session either (the same policy gates both), so a caller polling on a
     * "Realtime is the fast path" cadence should not stand down for us.
     */
    isSeedOnly() {
      return !this._tableReadable;
    }

    _cloneSeed() {
      const copy = new Map();
      for (const [playerId, m] of this._seed) copy.set(playerId, new Map(m));
      return copy;
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
      // Unconfirmed writes are re-applied by refresh(), so they need the same
      // shift or they'd resurrect the pre-removal numbering.
      this._writes.shiftRounds(idx);
      this._emit();
      if (!window.supabaseClient || !this.sessionId) return;
      try {
        // Let every per-cell write settle first. One landing AFTER the DELETE
        // below would re-insert its row at the PRE-shift index — precisely the
        // phantom trailing round this method exists to prevent.
        await this._writes.drain();
        // Delete the whole tail and rewrite it from the shifted map. A
        // per-row UPDATE ladder would collide with the
        // (session_id, participant_id, round_index) unique index partway
        // through; dropping the tail first cannot.
        const del = await window.supabaseClient
          .from("boardgamebuddy_play_session_scores")
          .delete()
          .eq("session_id", this.sessionId)
          .gte("round_index", idx);
        if (del && del.error) throw del.error;
        const rows = [];
        for (const [participantId, m] of this._byPlayer) {
          for (const [r, score] of m) {
            if (r < idx) continue;
            rows.push({
              participant_id: participantId,
              round_index: r,
              score: score == null ? null : score,
            });
          }
        }
        await this._sendRows(rows);
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

    getScore(participantId, roundIndex) {
      const m = this._byPlayer.get(participantId);
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
     * @param {string} participantId
     * @param {number} [roundCount] when given, only rounds [0, roundCount) count.
     */
    totalFor(participantId, roundCount) {
      const m = this._byPlayer.get(participantId);
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
     * by the spectator's grid to size its rows without round-count metadata
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

    async setAnyScore(participantId, roundIndex, value) {
      if (!this.isHost) {
        throw new Error("Only the host can score");
      }
      return this._upsert(participantId, roundIndex, value);
    }

    /**
     * Host-only. Publish the host's WHOLE grid in one write.
     *
     * setAnyScore mirrors a cell as the host types it, which covers the steady
     * state but not the moment spectators start watching. Two ways the table
     * can be behind the host's screen at that point:
     *
     *   1. A resumed draft. The host reloads mid-game and localStorage hands
     *      back a full grid; nothing re-publishes it.
     *   2. A player row whose participant_id arrived late (the 2s lobby poll
     *      backfills it), so cells typed before it landed had no key to
     *      mirror under.
     *
     * Either way a spectator would be missing scores the host can plainly see.
     * Called once on entering Play, after the initial backfill: for a single
     * writer the host's local draft is by definition the newer copy, so it
     * wins. One upsert for the whole grid rather than one per player.
     *
     * @param {Array<{participant_id?: string, roundScores?: Array<string|number|null>}>} players
     */
    async syncGrid(players) {
      if (!this.isHost) throw new Error("Only the host can score");
      if (!window.supabaseClient || !this.sessionId) return;
      const rows = [];
      for (const p of players || []) {
        if (!p || !p.participant_id) continue;
        const scores = Array.isArray(p.roundScores) ? p.roundScores : [];
        for (let r = 0; r < scores.length; r++) {
          const numeric = window.parseRoundScore(scores[r]);
          // Ingest locally too, so the host's own totals and maxRound() agree
          // with what we just published.
          this._ingest({ participant_id: p.participant_id, round_index: r, score: numeric });
          rows.push({
            participant_id: p.participant_id,
            round_index: r,
            score: numeric,
          });
        }
      }
      if (!rows.length) return;
      this._emit();
      try {
        // Settle per-cell writes first so this bulk copy can't be overtaken by
        // one of them. At the only call site today (entering Play) the queue is
        // empty and this is free; it keeps the method safe if it's ever called
        // mid-game.
        await this._writes.drain();
        await this._sendRows(rows);
      } catch (_) {
        // Best-effort, exactly like every other mirror write — the next
        // keystroke or refresh() reconciles.
      }
    }

    /**
     * The ONE place a write leaves this module, and the one place the result
     * is checked. Rows arrive without session_id; it's stamped on here.
     *
     * supabase-js v2 RESOLVES with {data, error} — it does not reject unless
     * .throwOnError() is set, and nothing here sets it. Converting to a
     * rejection is what makes the queue's failure path real: without it a 403
     * from the host-only RLS policy, or a write made with no network at all,
     * took the success path and reported a row as landed that never did.
     *
     * @param {Array<{participant_id: string, round_index: number, score: number?}>} rows
     * @returns {Promise<any>}
     */
    _sendRows(rows) {
      if (!window.supabaseClient || !this.sessionId || !rows || !rows.length) {
        return Promise.resolve();
      }
      return window.supabaseClient
        .from("boardgamebuddy_play_session_scores")
        .upsert(
          rows.map((r) => Object.assign({ session_id: this.sessionId }, r)),
          { onConflict: "session_id,participant_id,round_index" }
        )
        .then((res) => {
          if (res && res.error) throw res.error;
          return res;
        });
    }

    async _upsert(participantId, roundIndex, value) {
      const numeric =
        value === "" || value == null || Number.isNaN(Number(value))
          ? null
          : Number(value);
      // Optimistic local update so the keyboard input feels instant on a slow
      // network. SYNCHRONOUS, before anything awaits: play-flow-view's
      // _setRoundScore repaints totals and re-derives the crown right after
      // calling us and depends on this emit having already landed.
      this._ingest({
        participant_id: participantId,
        round_index: roundIndex,
        score: numeric,
      });
      this._emit();
      // The queue guarantees at most one request per cell is outstanding, so
      // two keystrokes in one cell can no longer reach the table out of order.
      return this._writes.queue(participantId, roundIndex, numeric);
    }

    _ingest(row) {
      this._ingestInto(this._byPlayer, row);
    }

    // Same ingest, into a caller-supplied map — refresh() builds a fresh one
    // so a wholesale re-read drops rows that no longer exist in the table.
    _ingestInto(byPlayer, row) {
      if (!row || !row.participant_id || row.round_index == null) return;
      let m = byPlayer.get(row.participant_id);
      if (!m) {
        m = new Map();
        byPlayer.set(row.participant_id, m);
      }
      m.set(Number(row.round_index), row.score == null ? null : Number(row.score));
    }

    _forget(row) {
      if (!row || !row.participant_id) return;
      const m = this._byPlayer.get(row.participant_id);
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
