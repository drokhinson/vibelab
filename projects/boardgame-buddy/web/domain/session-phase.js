// domain/session-phase.js — Realtime subscription to a session's phase.
//
// Joiners subscribe to UPDATE events on the host's row of
// boardgamebuddy_play_sessions so they auto-advance their read-only
// mirror the moment the host moves Gather → Play → Settle. RLS limits
// the read to host + participants (migration 026).

// @ts-check

(function () {
  /**
   * Subscribe to phase changes on a single play_sessions row.
   *
   * @param {string} sessionId — boardgamebuddy_play_sessions.id (UUID)
   * @param {(phase: string, row: any) => void} onPhaseChange — invoked
   *        every time the UPDATE payload contains a phase value.
   * @param {(dead: boolean) => void} [onDead] — invoked with true when the
   *        channel reports CHANNEL_ERROR / TIMED_OUT / CLOSED, and false when
   *        it reaches SUBSCRIBED. Optional; a caller with a poll fallback
   *        wants it, because without it a channel that never connected looks
   *        exactly like one that connected and has had nothing to say.
   * @returns {() => Promise<void>} unsubscribe
   */
  async function subscribePhase(sessionId, onPhaseChange, onDead) {
    if (!window.supabaseClient || !sessionId) {
      return async () => {};
    }
    const report = (dead) => {
      if (typeof onDead !== "function") return;
      try { onDead(dead); } catch (_) {}
    };
    const channel = window.supabaseClient
      .channel(`session:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "boardgamebuddy_play_sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          const next = payload.new || {};
          if (next && next.phase) {
            try { onPhaseChange(next.phase, next); } catch (_) {}
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") report(false);
        else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) report(true);
      });
    return async () => {
      try { await window.supabaseClient.removeChannel(channel); } catch (_) {}
    };
  }

  window.SessionPhase = { subscribe: subscribePhase };
})();
