// usePlaySession — the host cascade's engine. Owns the draft (AsyncStorage-
// persisted), the server lobby, the 2s gather poll, the LiveScores channel,
// and the phase state machine. Ports the web play-flow-view's async-safety
// invariants exactly:
//   • _phaseSeq token — a stale PATCH response never snaps the phase back
//   • _pendingPhase / _pendingDeletes — the poll skips ticks while a
//     user-initiated write is in flight
//   • lobby 404/410 vs transient blip — only a definitive "gone" mints a
//     new session code
// Score resolution: Realtime overlay wins for account players, local draft
// for ghosts; totals sum the same resolved cells the grid shows.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import api from '../../api/client';
import LiveScores from '../../realtime/liveScores';
import { emptyDraft, loadDraft, saveDraft, clearDraft } from '../../models/playSession';
import { sanitizeRoundScore, parseRoundScore, autoSelectWinners } from '../../domain/scoring';
import { savePlay } from './playSave';

export default function usePlaySession({ me, initialCode, initialGame }) {
  const draftRef = useRef(null);
  const lobbyRef = useRef(null);
  const liveRef = useRef(null);
  const phaseSeqRef = useRef(0);
  const pendingPhaseRef = useRef(0);
  const pendingDeletesRef = useRef(0);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);
  const [, bump] = useReducer((n) => n + 1, 0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const draft = draftRef.current;

  const persist = useCallback(() => {
    if (draftRef.current) saveDraft(draftRef.current);
  }, []);
  const repaint = useCallback(() => {
    if (mountedRef.current) bump();
  }, []);

  // ── Score resolution ────────────────────────────────────────────────────
  const resolvedScore = useCallback((player, roundIndex) => {
    if (liveRef.current && player.user_id) {
      const live = liveRef.current.getScore(player.user_id, roundIndex);
      if (live != null) return live;
    }
    const local = player.round_scores && player.round_scores[roundIndex];
    return parseRoundScore(local);
  }, []);

  const playerTotal = useCallback(
    (player) => {
      const n = (player.round_scores || []).length;
      let total = 0;
      for (let r = 0; r < n; r++) total += Number(resolvedScore(player, r)) || 0;
      return total;
    },
    [resolvedScore],
  );

  const maxRoundCount = useCallback(() => {
    const d = draftRef.current;
    if (!d || !d.players.length) return 0;
    return Math.max(0, ...d.players.map((p) => (p.round_scores || []).length));
  }, []);

  const runAutoWinners = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    if (autoSelectWinners(d.players, (i) => playerTotal(d.players[i]), d.playMode)) persist();
  }, [playerTotal, persist]);

  // ── Lobby ───────────────────────────────────────────────────────────────
  const reconcileGameToLobby = useCallback(() => {
    const d = draftRef.current;
    if (!d?.code || !d.game?.id) return;
    if (lobbyRef.current?.game_id === d.game.id) return;
    api.updateSession(d.code, d.game.id)
      .then(() => {
        if (lobbyRef.current) lobbyRef.current.game_id = d.game.id;
      })
      .catch(() => {});
  }, []);

  const ensureLobbyOpen = useCallback(async () => {
    const d = draftRef.current;
    if (d.code) {
      try {
        const s = await api.session(d.code);
        if (s && s.status === 'open' && s.phase && s.phase !== 'abandoned') {
          lobbyRef.current = s;
          d.sessionId = s.id;
          d.hostUserId = s.host_user_id;
          d.phase = s.phase;
          persist();
          reconcileGameToLobby();
          return;
        }
        // Server says the lobby is gone/closed — fall through to a fresh one.
      } catch (e) {
        const gone = e && (e.status === 404 || e.status === 410);
        if (!gone) {
          // Transient blip (wake-up, offline): keep the persisted code and
          // render from the draft — the poll reconnects. Minting a new code
          // here would abandon the real session.
          lobbyRef.current = {
            code: d.code,
            id: d.sessionId,
            host_user_id: d.hostUserId,
            phase: d.phase || 'gather',
            status: 'open',
            participants: lobbyRef.current?.participants || [],
          };
          return;
        }
      }
    }
    try {
      const session = await api.createSession(d.game?.id || null);
      lobbyRef.current = session;
      d.code = session.code;
      d.sessionId = session.id;
      d.hostUserId = session.host_user_id;
      d.phase = session.phase || 'gather';
      d.offlineTable = false;
      persist();
      reconcileGameToLobby();
    } catch (e) {
      if (e && e.status != null) {
        setError(e.message || 'Could not start a session');
        return;
      }
      // Network failure — run as an OFFLINE TABLE: no code, no live scores,
      // phases flip locally, and the finished play queues in the outbox.
      d.offlineTable = true;
      persist();
    }
  }, [persist, reconcileGameToLobby]);

  const lobbyPollTick = useCallback(async () => {
    const d = draftRef.current;
    if (!lobbyRef.current || !d) return;
    if (d.phase !== 'gather') return;
    if (pendingDeletesRef.current > 0 || pendingPhaseRef.current > 0) return;
    try {
      const next = await api.session(lobbyRef.current.code);
      lobbyRef.current = next;
      let playersChanged = false;
      const byName = new Map(d.players.map((p, i) => [(p.name || '').toLowerCase(), i]));
      for (const part of next.participants || []) {
        const key = (part.display_name || '').toLowerCase();
        if (!key) continue;
        if (byName.has(key)) {
          const existing = d.players[byName.get(key)];
          if (existing && !existing.participant_id) {
            existing.participant_id = part.id;
            playersChanged = true;
          }
          continue;
        }
        d.players.push({
          name: part.display_name,
          is_winner: false,
          score: null,
          round_scores: [],
          user_id: part.user_id || null,
          avatar: part.avatar || null,
          participant_id: part.id,
        });
        byName.set(key, d.players.length - 1);
        playersChanged = true;
      }
      if (playersChanged) {
        persist();
        repaint();
      }
    } catch {}
  }, [persist, repaint]);

  // ── Live scores ─────────────────────────────────────────────────────────
  const startLiveScores = useCallback(async () => {
    const d = draftRef.current;
    if (liveRef.current || !d?.sessionId) return;
    const live = new LiveScores({ sessionId: d.sessionId, isHost: true, currentUserId: me?.id || null });
    liveRef.current = live;
    await live.start();
    live.subscribe(() => {
      runAutoWinners();
      repaint();
    });
    repaint();
  }, [me?.id, repaint, runAutoWinners]);

  // ── Boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      let d = await loadDraft();
      if (initialCode && d?.code !== initialCode) d = null; // deep link to a different session
      if (!d) d = emptyDraft();
      if (!d.game && initialGame) d.game = initialGame;
      if (!d.players.length && me) {
        d.players.push({ name: me.display_name, is_winner: false, score: null, round_scores: [], user_id: me.id, avatar: me.avatar || null });
      }
      if (initialCode) d.code = initialCode;
      draftRef.current = d;
      saveDraft(d);
      await ensureLobbyOpen();
      if (!mountedRef.current) return;
      setReady(true);
      repaint();
      pollRef.current = setInterval(lobbyPollTick, 2000);
      await startLiveScores();
    })();
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      const live = liveRef.current;
      liveRef.current = null;
      // Fire-and-forget: awaiting removeChannel can hang if the socket never
      // reached READY.
      if (live) Promise.resolve().then(() => live.stop()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mutations (Gather) ──────────────────────────────────────────────────
  const mutate = useCallback(
    (fn) => {
      const d = draftRef.current;
      if (!d) return;
      fn(d);
      persist();
      repaint();
    },
    [persist, repaint],
  );

  const pickGame = useCallback(
    (game) => {
      mutate((d) => {
        d.game = game;
        d.playMode = game.play_mode || d.playMode || 'competitive';
        d.expansionIds = [];
      });
      reconcileGameToLobby();
    },
    [mutate, reconcileGameToLobby],
  );

  const addPlayer = useCallback(
    ({ name, user_id = null, avatar = null }) => {
      const d = draftRef.current;
      const clean = (name || '').trim();
      if (!clean) return;
      if (d.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return;
      const rounds = maxRoundCount();
      mutate((dd) =>
        dd.players.push({
          name: clean,
          is_winner: false,
          score: null,
          round_scores: Array(rounds).fill(null),
          user_id,
          avatar,
        }),
      );
      // Account players also join the lobby so their live-score column works.
      if (user_id && d.code) {
        api
          .addParticipant(d.code, { userId: user_id, displayName: clean })
          .then((updated) => {
            lobbyRef.current = updated;
            const part = (updated.participants || []).find((p) => p.user_id === user_id);
            if (part) mutate((dd) => {
              const row = dd.players.find((p) => p.user_id === user_id);
              if (row) row.participant_id = part.id;
            });
          })
          .catch(() => {});
      }
    },
    [mutate, maxRoundCount],
  );

  const removePlayer = useCallback(
    (index) => {
      const d = draftRef.current;
      const p = d.players[index];
      if (!p) return;
      mutate((dd) => dd.players.splice(index, 1));
      if (p.participant_id && d.code) {
        pendingDeletesRef.current++;
        api
          .removeParticipant(d.code, p.participant_id)
          .catch(() => {})
          .finally(() => {
            pendingDeletesRef.current--;
          });
      }
    },
    [mutate],
  );

  // ── Scoring (Play) ──────────────────────────────────────────────────────
  const setRoundScore = useCallback(
    (playerIndex, roundIndex, value) => {
      const d = draftRef.current;
      const p = d.players[playerIndex];
      if (!p) return;
      const clean = sanitizeRoundScore(value);
      mutate(() => {
        if (!Array.isArray(p.round_scores)) p.round_scores = [];
        p.round_scores[roundIndex] = clean === '' ? null : clean;
      });
      // Mirror authed-player edits into live scores so joiners see the
      // host's override. Ghosts stay local-only.
      if (liveRef.current && p.user_id) {
        liveRef.current.setAnyScore(p.user_id, roundIndex, parseRoundScore(clean)).catch(() => {});
      }
      runAutoWinners();
    },
    [mutate, runAutoWinners],
  );

  const addRound = useCallback(() => {
    mutate((d) => {
      for (const p of d.players) {
        if (!Array.isArray(p.round_scores)) p.round_scores = [];
        p.round_scores.push(null);
      }
    });
  }, [mutate]);

  const removeRound = useCallback(
    (r) => {
      mutate((d) => {
        for (const p of d.players) {
          if (Array.isArray(p.round_scores) && r >= 0 && r < p.round_scores.length) p.round_scores.splice(r, 1);
        }
      });
      runAutoWinners();
    },
    [mutate, runAutoWinners],
  );

  const toggleWinner = useCallback(
    (i) => {
      mutate((d) => {
        const p = d.players[i];
        if (!p) return;
        const next = !p.is_winner;
        if (d.playMode === 'cooperative') {
          for (const other of d.players) other.is_winner = next;
        } else {
          p.is_winner = next;
        }
      });
    },
    [mutate],
  );

  // ── Phase machine ───────────────────────────────────────────────────────
  const advancePhase = useCallback(
    async (next) => {
      const d = draftRef.current;
      // Offline table (or no lobby yet): the phase is local-only. Nobody is
      // following it server-side, so just flip and go.
      if (d.offlineTable || !lobbyRef.current?.code) {
        if (!d.offlineTable && !lobbyRef.current?.code) {
          setError('Session not ready yet.');
          return false;
        }
        setError(null);
        d.phase = next;
        persist();
        repaint();
        return true;
      }
      setError(null);
      const prevPhase = d.phase;
      const seq = ++phaseSeqRef.current;
      d.phase = next;
      persist();
      repaint();
      pendingPhaseRef.current++;
      try {
        const updated = await api.updateSessionPhase(lobbyRef.current.code, next);
        if (seq !== phaseSeqRef.current) return true; // newer change owns state
        lobbyRef.current = updated;
        if (updated.phase && updated.phase !== d.phase) {
          d.phase = updated.phase;
          persist();
          repaint();
        }
        if (next === 'play') startLiveScores();
        return true;
      } catch (e) {
        if (seq !== phaseSeqRef.current) return true;
        if (e && e.status == null) {
          // Dead link mid-game must not trap the host on a screen: keep the
          // optimistic flip. The save path falls back to the outbox anyway.
          return true;
        }
        d.phase = prevPhase;
        persist();
        setError(e.message || 'Could not advance to the next screen');
        repaint();
        return false;
      } finally {
        pendingPhaseRef.current--;
      }
    },
    [persist, repaint, startLiveScores],
  );

  const abandon = useCallback(async () => {
    // Tear down locally FIRST — a slow or hung PATCH must not strand the
    // user. Server abandon is fire-and-forget.
    const code = lobbyRef.current?.code;
    await clearDraft();
    draftRef.current = null;
    if (code) api.updateSessionPhase(code, 'abandoned').catch(() => {});
  }, []);

  // ── Save ────────────────────────────────────────────────────────────────
  //
  // Split in two so the wrap-up card can go up in the same frame as the tap
  // and the write can run behind it. Everything the write (and a follow-up
  // round) needs is captured up front, because the draft is cleared on
  // success and recycled by startAnotherRound.

  /** Snapshot for a save that will run behind the card. `null` if not ready. */
  const snapshotForSave = useCallback(() => {
    const d = draftRef.current;
    if (!d?.game?.id) {
      setError('Pick a game first.');
      return null;
    }
    return {
      draft: d,
      lobbyCode: lobbyRef.current?.code || null,
      rounds: maxRoundCount(),
      game: d.game,
      winner: d.players.find((p) => p.is_winner) || null,
      photoUrl: d.photo?.uri || null,
      // Memoized upload promise lives here so a Retry doesn't re-push bytes.
      uploadPromise: null,
    };
  }, [maxRoundCount]);

  /**
   * Persist the play. On failure the draft is left completely intact, so a
   * Retry can re-fire the same snapshot and dismissing the card lands back
   * on an untouched Settle Up.
   */
  const runSave = useCallback(
    async (snap) => {
      setSaving(true);
      setError(null);
      const result = await savePlay(snap.draft, snap.lobbyCode, {
        rounds: snap.rounds,
        resolvedScore,
        snap,
      });
      if (!result.ok) {
        setSaving(false);
        return { ok: false, error: result.error };
      }
      // The play is on the server (or safely queued) — drop the persisted
      // copy so the Play tab stops offering to resume it. The in-memory
      // draft stays put on purpose: the wrap-up card is covering Settle Up,
      // and tearing it down now would flash a loading screen behind the
      // card. It goes with the screen on dismiss, or is replaced wholesale
      // by startAnotherRound.
      await clearDraft();
      setSaving(false);
      return { ...result, game: snap.game, winner: snap.winner, photoUrl: snap.photoUrl };
    },
    [resolvedScore],
  );

  /**
   * Everything that carries into a follow-up game with the same group.
   * Deliberately drops per-play results and `participant_id` — the latter
   * belongs to the finished session's lobby rows, and reusing it would make
   * removePlayer issue a DELETE against the wrong session.
   */
  const nextRoundSeed = useCallback(() => {
    const d = draftRef.current;
    if (!d) return null;
    return {
      game: d.game,
      expansionIds: [...(d.expansionIds || [])],
      playMode: d.playMode,
      players: (d.players || []).map((p) => ({
        name: p.name,
        user_id: p.user_id || null,
        avatar: p.avatar || null,
        team: p.team || '',
        is_winner: false,
        score: null,
        round_scores: [],
      })),
    };
  }, []);

  /**
   * Start a fresh session pre-seeded with the same game, expansions, play
   * mode and roster, landing on Gather so the host can still tweak the
   * line-up (and joiners get a window to re-join under the new code).
   */
  const startAnotherRound = useCallback(
    async (seed) => {
      if (!seed) return;
      // Tear down the finished session's live wiring — mirrors unmount.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      const live = liveRef.current;
      liveRef.current = null;
      if (live) Promise.resolve().then(() => live.stop()).catch(() => {});
      lobbyRef.current = null;

      // Reset the async guards so an in-flight call from the finished
      // session can't reconcile into the new one.
      phaseSeqRef.current++;
      pendingPhaseRef.current = 0;
      pendingDeletesRef.current = 0;
      setError(null);
      setSaving(false);

      const d = emptyDraft();
      d.game = seed.game;
      d.expansionIds = seed.expansionIds;
      d.playMode = seed.playMode;
      d.players = seed.players.map((p) => ({ ...p }));
      if (!d.players.length && me) {
        d.players.push({ name: me.display_name, is_winner: false, score: null, round_scores: [], user_id: me.id, avatar: me.avatar || null });
      }
      draftRef.current = d;
      saveDraft(d);
      // Paint the prefilled Gather screen before any network work.
      repaint();

      await ensureLobbyOpen();
      // POST /sessions seats only the host, so the carried roster needs
      // explicit participant rows before joiners can see the group.
      const code = lobbyRef.current?.code;
      if (code) {
        await Promise.all(
          d.players
            .filter((p) => !p.participant_id && !(me && p.user_id === me.id))
            .map((p) =>
              api
                .addParticipant(code, { userId: p.user_id || null, displayName: p.name })
                .catch(() => {}),
            ),
        );
      }
      repaint();
      pollRef.current = setInterval(lobbyPollTick, 2000);
      await startLiveScores();
    },
    [me, repaint, ensureLobbyOpen, lobbyPollTick, startLiveScores],
  );

  return {
    ready,
    error,
    saving,
    draft,
    lobby: lobbyRef.current,
    live: liveRef.current,
    setError,
    mutate,
    pickGame,
    addPlayer,
    removePlayer,
    setRoundScore,
    addRound,
    removeRound,
    toggleWinner,
    resolvedScore,
    playerTotal,
    maxRoundCount,
    advancePhase,
    abandon,
    snapshotForSave,
    runSave,
    nextRoundSeed,
    startAnotherRound,
  };
}
