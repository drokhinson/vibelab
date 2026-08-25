// useSessionWatch — the joiner's session engine. Realtime phase subscription
// with a 4s poll safety net (participants/game/phase diffing), auto-join
// during gather, LiveScores in play phase, and terminal-phase side effects
// (abandoned → exit banner, finalized → winner splash). Mirrors
// web/views/session-viewer-view.js.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import api from '../../api/client';
import LiveScores from '../../realtime/liveScores';
import { subscribePhase } from '../../realtime/sessionPhase';

export default function useSessionWatch({ code, me, onFinalized, onAbandoned }) {
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState('gather');
  const [error, setError] = useState(null);
  const [rounds, setRounds] = useState(1);
  const liveRef = useRef(null);
  const finishedRef = useRef(false);
  const joinTriedRef = useRef(false);
  const [, bump] = useReducer((n) => n + 1, 0);

  const handleTerminal = useCallback(
    (nextPhase, row) => {
      if (finishedRef.current) return;
      if (nextPhase === 'finalized') {
        finishedRef.current = true;
        onFinalized?.(row);
      } else if (nextPhase === 'abandoned') {
        finishedRef.current = true;
        onAbandoned?.();
      }
    },
    [onFinalized, onAbandoned],
  );

  const load = useCallback(async () => {
    try {
      const s = await api.session(code);
      setSession(s);
      setError(null);
      if (s.phase) {
        setPhase(s.phase);
        handleTerminal(s.phase, s);
      }
      // Auto-join once during gather if we're not at the table yet.
      if (
        !joinTriedRef.current &&
        me &&
        s.phase === 'gather' &&
        s.host_user_id !== me.id &&
        !(s.participants || []).some((p) => p.user_id === me.id)
      ) {
        joinTriedRef.current = true;
        api.joinSession(code, me.display_name).then(setSession, () => {});
      }
    } catch (e) {
      // A vanished session (expired/abandoned + cleaned up) is terminal.
      if (e.status === 404 || e.status === 410) handleTerminal('abandoned');
      else setError(e.message);
    }
  }, [code, me, handleTerminal]);

  // Initial load + poll safety net (Realtime can drop on mobile networks).
  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  // Realtime phase subscription — instant transitions between polls.
  useEffect(() => {
    if (!session?.id) return undefined;
    const off = subscribePhase(session.id, (newPhase, row) => {
      setPhase(newPhase);
      handleTerminal(newPhase, row);
    });
    return () => {
      Promise.resolve().then(off).catch(() => {});
    };
  }, [session?.id, handleTerminal]);

  // Live scores while playing (and during settle so the grid stays visible).
  useEffect(() => {
    if ((phase !== 'play' && phase !== 'settle') || !session?.id) return undefined;
    if (liveRef.current) return undefined;
    const live = new LiveScores({ sessionId: session.id, isHost: false });
    liveRef.current = live;
    let off = null;
    live.start().then(() => {
      off = live.subscribe(() => {
        setRounds((r) => Math.max(r, live.maxRound() + 1));
        bump();
      });
      setRounds((r) => Math.max(r, live.maxRound() + 1));
      bump();
    });
    return () => {
      if (off) off();
      // Fire-and-forget teardown — awaiting can hang on a dead socket.
      Promise.resolve().then(() => live.stop()).catch(() => {});
      liveRef.current = null;
    };
  }, [phase, session?.id, me?.id]);

  return { session, phase, rounds, error, live: liveRef.current, reload: load };
}
