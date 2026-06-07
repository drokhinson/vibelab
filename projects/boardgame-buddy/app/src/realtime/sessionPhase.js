// sessionPhase — subscribe to a live session's phase changes via Supabase
// Realtime. Ported from web/domain/session-phase.js (window.supabaseClient →
// the ESM client). Returns an async unsubscribe.

import { supabase } from '../auth/supabase';

export function subscribePhase(sessionId, onPhaseChange) {
  if (!supabase || !sessionId) return async () => {};
  const channel = supabase
    .channel(`session:${sessionId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'boardgamebuddy_play_sessions', filter: `id=eq.${sessionId}` },
      (payload) => {
        const row = payload.new || {};
        if (row.phase) onPhaseChange(row.phase, row);
      },
    )
    .subscribe();

  return async () => {
    try { await supabase.removeChannel(channel); } catch {}
  };
}
