// liveScores — Realtime per-player live scores during the Play phase. Wraps a
// Supabase channel on boardgamebuddy_play_session_scores. Writes go straight to
// the table via the anon key; RLS (migration 026) enforces that joiners can
// only touch their own column and the host can override anyone in their session.
// Ported verbatim from web/domain/live-scores.js (window.supabaseClient → ESM).

import { supabase } from '../auth/supabase';

export default class LiveScores {
  constructor({ sessionId, isHost, currentUserId }) {
    this.sessionId = sessionId;
    this.isHost = !!isHost;
    this.currentUserId = currentUserId;
    this._channel = null;
    this._listeners = new Set();
    this._byPlayer = new Map(); // Map<player_user_id, Map<round_index, score>>
  }

  async start() {
    if (!supabase || !this.sessionId) return;
    try {
      const { data } = await supabase
        .from('boardgamebuddy_play_session_scores')
        .select('session_id, player_user_id, round_index, score')
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

  getScore(playerUserId, roundIndex) {
    const m = this._byPlayer.get(playerUserId);
    if (!m) return null;
    const v = m.get(roundIndex);
    return v == null ? null : v;
  }

  totalFor(playerUserId) {
    const m = this._byPlayer.get(playerUserId);
    if (!m) return 0;
    let total = 0;
    for (const v of m.values()) total += Number(v) || 0;
    return total;
  }

  maxRound() {
    let max = -1;
    for (const m of this._byPlayer.values()) {
      for (const k of m.keys()) if (k > max) max = k;
    }
    return max;
  }

  async setMyScore(roundIndex, value) {
    if (!this.currentUserId) throw new Error('Not signed in');
    return this._upsert(this.currentUserId, roundIndex, value);
  }

  async setAnyScore(playerUserId, roundIndex, value) {
    if (!this.isHost) throw new Error('Only the host can override scores');
    return this._upsert(playerUserId, roundIndex, value);
  }

  async _upsert(playerUserId, roundIndex, value) {
    const numeric = value === '' || value == null || Number.isNaN(Number(value)) ? null : Number(value);
    this._ingest({ player_user_id: playerUserId, round_index: roundIndex, score: numeric });
    this._emit();
    const row = { session_id: this.sessionId, player_user_id: playerUserId, round_index: roundIndex, score: numeric };
    return supabase.from('boardgamebuddy_play_session_scores').upsert(row, { onConflict: 'session_id,player_user_id,round_index' });
  }

  _ingest(row) {
    if (!row || !row.player_user_id || row.round_index == null) return;
    let m = this._byPlayer.get(row.player_user_id);
    if (!m) { m = new Map(); this._byPlayer.set(row.player_user_id, m); }
    m.set(Number(row.round_index), row.score == null ? null : Number(row.score));
  }

  _forget(row) {
    if (!row || !row.player_user_id) return;
    const m = this._byPlayer.get(row.player_user_id);
    if (m) m.delete(Number(row.round_index));
  }

  _emit() {
    for (const fn of this._listeners) { try { fn(); } catch {} }
  }
}
