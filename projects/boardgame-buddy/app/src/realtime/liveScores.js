// liveScores — Realtime live scores during the Play phase. Wraps a Supabase
// channel on boardgamebuddy_play_session_scores. The host's device writes
// straight to the table via the anon key and everybody else reads; RLS
// (migration 053) enforces that only the host of the session can write, and
// only while phase='play'.
//
// Cells are keyed (participant_id, round_index) — the roster row, not the
// account — which is what lets a GUEST's column stream too. Before 053 the
// table was keyed by player_user_id, so a guest was unrepresentable and their
// column never reached anyone else's screen.
//
// Ported from web/domain/live-scores.js (window.supabaseClient → ESM); keep
// the two in step.

import { supabase } from '../auth/supabase';

export default class LiveScores {
  constructor({ sessionId, isHost }) {
    this.sessionId = sessionId;
    this.isHost = !!isHost;
    this._channel = null;
    this._listeners = new Set();
    this._byPlayer = new Map(); // Map<participant_id, Map<round_index, score>>
  }

  async start() {
    if (!supabase || !this.sessionId) return;
    try {
      const { data } = await supabase
        .from('boardgamebuddy_play_session_scores')
        .select('session_id, participant_id, round_index, score')
        .eq('session_id', this.sessionId);
      for (const row of data || []) this._ingest(row);
    } catch {}
    this._channel = supabase
      .channel(`scores:${this.sessionId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'boardgamebuddy_play_session_scores', filter: `session_id=eq.${this.sessionId}` },
        (payload) => {
          const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
          if (!row) return;
          if (payload.eventType === 'DELETE') this._forget(row);
          else this._ingest(row);
          this._emit();
        },
      )
      .subscribe();
    this._emit();
  }

  async stop() {
    if (this._channel && supabase) {
      try { await supabase.removeChannel(this._channel); } catch {}
    }
    this._channel = null;
    this._listeners.clear();
    this._byPlayer.clear();
  }

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
   * Sum a column, bounded to the rounds the grid is actually showing. Pass
   * roundCount wherever a total sits under a grid: a round the host removed can
   * still have rows in flight, and summing them is how a total ends up bigger
   * than the cells above it (migration 052's whole subject).
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

  maxRound() {
    let max = -1;
    for (const m of this._byPlayer.values()) {
      for (const k of m.keys()) if (k > max) max = k;
    }
    return max;
  }

  /**
   * Host-only. Delete every score row at or after a round index so the round
   * really disappears from spectators' grids. Writing NULLs instead would leave
   * the rows in place, and maxRound() — which spectators size their grid from —
   * would keep the round alive and grow the host's grid straight back.
   *
   * Migration 053 granted DELETE for the first time; before it this call 403'd
   * into the catch below, which is why a removed round used to linger on every
   * spectator's screen as a phantom trailing column.
   */
  async removeRoundAt(roundIndex) {
    if (!this.isHost) throw new Error('Only the host can remove a round');
    const idx = Number(roundIndex);
    if (!Number.isFinite(idx) || idx < 0) return;
    for (const m of this._byPlayer.values()) {
      for (const r of [...m.keys()]) if (r >= idx) m.delete(r);
    }
    this._emit();
    if (!supabase || !this.sessionId) return;
    try {
      await supabase
        .from('boardgamebuddy_play_session_scores')
        .delete()
        .eq('session_id', this.sessionId)
        .gte('round_index', idx);
    } catch {}
  }

  async setAnyScore(participantId, roundIndex, value) {
    if (!this.isHost) throw new Error('Only the host can score');
    return this._upsert(participantId, roundIndex, value);
  }

  /**
   * Host-only. Publish the host's whole grid in one write, on entering Play.
   * setAnyScore mirrors each cell as it's typed, but a resumed draft (or a row
   * whose participant_id landed late) can hold cells the table has never seen,
   * and spectators can no longer fill in the gaps themselves. For a single
   * writer the local draft is by definition the newer copy, so it wins.
   * @param {Array<{participant_id: string, roundScores: Array<any>}>} players
   */
  async syncGrid(players) {
    if (!this.isHost) throw new Error('Only the host can score');
    if (!supabase || !this.sessionId) return;
    const rows = [];
    for (const p of players || []) {
      if (!p || !p.participant_id) continue;
      const scores = Array.isArray(p.roundScores) ? p.roundScores : [];
      for (let r = 0; r < scores.length; r++) {
        const numeric = _numeric(scores[r]);
        this._ingest({ participant_id: p.participant_id, round_index: r, score: numeric });
        rows.push({ session_id: this.sessionId, participant_id: p.participant_id, round_index: r, score: numeric });
      }
    }
    if (!rows.length) return;
    this._emit();
    try {
      await supabase
        .from('boardgamebuddy_play_session_scores')
        .upsert(rows, { onConflict: 'session_id,participant_id,round_index' });
    } catch {}
  }

  async _upsert(participantId, roundIndex, value) {
    const numeric = _numeric(value);
    this._ingest({ participant_id: participantId, round_index: roundIndex, score: numeric });
    this._emit();
    const row = { session_id: this.sessionId, participant_id: participantId, round_index: roundIndex, score: numeric };
    return supabase.from('boardgamebuddy_play_session_scores').upsert(row, { onConflict: 'session_id,participant_id,round_index' });
  }

  _ingest(row) {
    if (!row || !row.participant_id || row.round_index == null) return;
    let m = this._byPlayer.get(row.participant_id);
    if (!m) { m = new Map(); this._byPlayer.set(row.participant_id, m); }
    m.set(Number(row.round_index), row.score == null ? null : Number(row.score));
  }

  _forget(row) {
    if (!row || !row.participant_id) return;
    const m = this._byPlayer.get(row.participant_id);
    if (m) m.delete(Number(row.round_index));
  }

  _emit() {
    for (const fn of this._listeners) { try { fn(); } catch {} }
  }
}

// "" / null / a half-typed "-" are all "no score yet", not zero.
function _numeric(value) {
  return value === '' || value == null || Number.isNaN(Number(value)) ? null : Number(value);
}
