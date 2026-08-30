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
import { emptyDraft, loadDraft, saveDraft, clearDraft, PHASES as PHASE_ORDER } from '../../models/playSession';
import { sanitizeRoundScore, parseRoundScore, autoSelectWinners } from '../../domain/scoring';
import { isCoop, normalizePlayMode } from '../../domain/playMode';
import { savePlay } from './playSave';

/** Definitively gone — not a blip. See withLobby for why the line is here. */
function isLobbyGone(e) {
  return !!e && (e.status === 404 || e.status === 410);
}

export default function usePlaySession({ me, initialCode, initialGame, fresh }) {
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
  // The server refused to mint a lobby. Surfaced on the invite card, not as a
  // cascade-wide error — the host can still play and record.
  const [lobbyFailed, setLobbyFailed] = useState(false);
  // The code the host may already have read out to the table changed under
  // them. A line on the invite card, never a modal — this can fire while
  // they're typing in the scoring grid.
  const [codeReplaced, setCodeReplaced] = useState(false);

  const draft = draftRef.current;

  const persist = useCallback(() => {
    if (draftRef.current) saveDraft(draftRef.current);
  }, []);
  const repaint = useCallback(() => {
    if (mountedRef.current) bump();
  }, []);

  // ── Score resolution ────────────────────────────────────────────────────
  // Live cells are keyed by PARTICIPANT row, not account (migration 053) —
  // which is what lets a guest's column stream. A player without a
  // participant_id yet (offline table, or the poll hasn't matched them) simply
  // reads from the local draft.
  // The LOCAL draft wins, always. This device is the only writer under
  // host-only scoring (migration 053), so the overlay carries nothing but our
  // own echoes — and typing "36" fires two independent upserts, 3 then 36,
  // with no ordering between them. Letting the overlay win means the 3 landing
  // last silently rewrites the cell, and on web that reached the saved play.
  // The overlay stays authoritative on the spectator's screen, which has no
  // draft of its own; here it's only a fallback for a cell we never typed.
  const resolvedScore = useCallback((player, roundIndex) => {
    const local = player.round_scores && player.round_scores[roundIndex];
    if (local != null && local !== '') return parseRoundScore(local);
    if (liveRef.current && player.participant_id) {
      const live = liveRef.current.getScore(player.participant_id, roundIndex);
      if (live != null) return live;
    }
    return parseRoundScore(local);
  }, []);

  // The grid's width: the longest column. Declared before playerTotal because
  // that bounds its sum by it.
  const maxRoundCount = useCallback(() => {
    const d = draftRef.current;
    if (!d || !d.players.length) return 0;
    return Math.max(0, ...d.players.map((p) => (p.round_scores || []).length));
  }, []);

  // Sum only the rounds the grid is showing. A column shorter than the grid
  // contributes nothing for the missing rounds — which keeps the Total equal
  // to the cells above it even when the live overlay still holds a round the
  // host has removed (migration 052's subject).
  const playerTotal = useCallback(
    (player) => {
      const n = maxRoundCount();
      let total = 0;
      for (let r = 0; r < n; r++) total += Number(resolvedScore(player, r)) || 0;
      return total;
    },
    [resolvedScore, maxRoundCount],
  );

  const runAutoWinners = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    if (autoSelectWinners(d.players, (i) => playerTotal(d.players[i]), d.playMode)) persist();
  }, [playerTotal, persist]);

  // ── Lobby ───────────────────────────────────────────────────────────────
  // Late-bound so the healing layer can be defined after the things it drives
  // (the roster push and the phase replay) without a circular useCallback.
  const withLobbyRef = useRef(null);
  const onLobbyReplacedRef = useRef(null);
  const healPromiseRef = useRef(null);

  const reconcileGameToLobby = useCallback(() => {
    const d = draftRef.current;
    if (!d?.code || !d.game?.id) return;
    if (lobbyRef.current?.game_id === d.game.id) return;
    withLobbyRef.current?.((code) => api.updateSession(code, d.game.id)).then((ok) => {
      if (ok && lobbyRef.current) lobbyRef.current.game_id = d.game.id;
    });
  }, []);

  const ensureLobbyOpen = useCallback(async () => {
    const d = draftRef.current;
    if (d.code) {
      const seq = phaseSeqRef.current;
      try {
        const s = await api.session(d.code);
        if (s && s.status === 'open' && s.phase && s.phase !== 'abandoned') {
          lobbyRef.current = s;
          d.sessionId = s.id;
          d.hostUserId = s.host_user_id;
          // Only adopt the server's phase if the host hasn't moved while this
          // was in flight. A lobby is always born in 'gather', so without the
          // token a mint that lands after the host tapped Continue would yank
          // them straight back off Play.
          if (phaseSeqRef.current === seq) d.phase = s.phase;
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
      setLobbyFailed(false);
      persist();
      reconcileGameToLobby();
    } catch (e) {
      if (e && e.status != null) {
        // A refused mint is not a refused game. The host keeps the whole
        // cascade and records the play; they just don't get a code to share,
        // which the invite card says quietly rather than as a red alert over
        // everything.
        setLobbyFailed(true);
        return;
      }
      // Network failure — run as an OFFLINE TABLE: no code, no live scores,
      // phases flip locally, and the finished play queues in the outbox.
      d.offlineTable = true;
      persist();
    }
  }, [persist, reconcileGameToLobby]);

  /**
   * Replace a lobby the server has disowned. Resolves the new code, or null.
   *
   * Single-flight, and that is the whole point: a roster push fails N writes at
   * the same instant, and bgb_create_session abandons the host's other open
   * sessions — so N independent mints would each kill the one before it and
   * leave the host on a code its own successor had already abandoned.
   */
  const healLobby = useCallback(
    (deadCode) => {
      if (healPromiseRef.current) return healPromiseRef.current;
      healPromiseRef.current = (async () => {
        // Someone else already healed while we were queued behind them.
        const current = lobbyRef.current?.code || null;
        if (current && current !== deadCode) return current;
        const d = draftRef.current;
        lobbyRef.current = null;
        if (d) {
          // Drop the draft's copy too, so ensureLobbyOpen takes its create
          // branch instead of re-validating the corpse.
          d.code = null;
          d.sessionId = null;
          persist();
        }
        await ensureLobbyOpen();
        const next = lobbyRef.current?.code || null;
        if (next && next !== deadCode) onLobbyReplacedRef.current?.();
        return next;
      })();
      healPromiseRef.current.catch(() => {}).then(() => {
        healPromiseRef.current = null;
      });
      return healPromiseRef.current;
    },
    [persist, ensureLobbyOpen],
  );

  /**
   * Run a write against this run's lobby, healing a dead lobby rather than
   * reporting it. Resolves the write's result, or null when there was no lobby
   * to write to (offline, mint failed, or the retry failed too).
   *
   * Only 404/410 count as gone. A 5xx or a network error is a blip, and
   * re-minting on a hiccup abandons a live session and hands the table a code
   * nobody has. 409 roster_locked and 400 invalid_transition are deliberately
   * NOT definitive either — they come from a perfectly healthy lobby.
   *
   * @param {(code: string) => Promise<any>} fn
   */
  const withLobby = useCallback(
    async (fn) => {
      let code = lobbyRef.current?.code || null;
      if (!code) return null;
      try {
        return await fn(code);
      } catch (e) {
        if (!isLobbyGone(e)) return null;
      }
      code = await healLobby(code);
      if (!code) return null;
      try {
        return await fn(code);
      } catch {
        return null;
      }
    },
    [healLobby],
  );
  withLobbyRef.current = withLobby;

  /**
   * Give every local player a participant row. POST /sessions seats only the
   * host, so a roster the draft already carried — "Another Round", a resumed
   * draft, a healed lobby — has none. Since migration 053 keys live scores by
   * participant, a player without one has no column on any spectator's grid.
   *
   * Best-effort per player: a failed write costs a spectator that column, and
   * costs the host nothing. The host themselves is seated by the mint.
   */
  const pushRosterToLobby = useCallback(async () => {
    const d = draftRef.current;
    const code = lobbyRef.current?.code;
    if (!d || !code) return;
    const pending = (d.players || []).filter(
      (p) => !p.participant_id && !(me && p.user_id === me.id),
    );
    if (!pending.length) return;
    await Promise.all(
      pending.map((p) =>
        api.addParticipant(code, { userId: p.user_id || null, displayName: p.name }).catch(() => {}),
      ),
    );
  }, [me]);

  const lobbyPollTick = useCallback(async () => {
    const d = draftRef.current;
    if (!lobbyRef.current || !d) return;
    if (d.phase !== 'gather') return;
    if (pendingDeletesRef.current > 0 || pendingPhaseRef.current > 0) return;
    try {
      // Through withLobby so a lobby that died under the host self-heals
      // instead of this 404ing in silence every two seconds forever.
      const next = await withLobbyRef.current?.((code) => api.session(code));
      if (!next) return;
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
    const live = new LiveScores({ sessionId: d.sessionId, isHost: true });
    liveRef.current = live;
    await live.start();
    // Publish the grid this device is actually showing. start() only READ the
    // table, and a resumed draft (or one whose participant_ids landed after
    // the cells were typed) holds scores the table has never seen. Spectators
    // are read-only now, so nobody else would ever fill those gaps in.
    live
      .syncGrid(
        (d.players || [])
          .filter((p) => p.participant_id)
          .map((p) => ({ participant_id: p.participant_id, roundScores: p.round_scores || [] })),
      )
      .catch(() => {});
    live.subscribe(() => {
      runAutoWinners();
      repaint();
    });
    repaint();
  }, [repaint, runAutoWinners]);

  // ── Boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      let d = await loadDraft();
      if (initialCode && d?.code !== initialCode) d = null; // deep link to a different session
      // "Host a game" always starts a new one. Without this the previous run's
      // draft is silently resumed — including its finished session's code, so
      // every write goes to a lobby the server has already closed. Resume is
      // the one path that continues a session, and it says so.
      if (fresh) d = null;
      if (!d) d = emptyDraft();
      if (!d.game && initialGame) d.game = initialGame;
      if (!d.players.length && me) {
        d.players.push({ name: me.display_name, is_winner: false, score: null, round_scores: [], user_id: me.id, avatar: me.avatar || null });
      }
      if (initialCode) d.code = initialCode;
      draftRef.current = d;
      saveDraft(d);
      await ensureLobbyOpen();
      // A draft can arrive already holding a roster — the Play tab's "Another
      // Round" card seeds every player from the last play — and POST /sessions
      // seats only the host. Since 053 keys live scores by participant, a
      // player with no participant row has no column on any spectator's grid.
      await pushRosterToLobby();
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
        d.playMode = normalizePlayMode(game.play_mode || d.playMode);
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
      // EVERY player joins the lobby, guests included. Since migration 053 a
      // participant row is what live scores are keyed by, so a guest without
      // one has a column no spectator ever sees. (The local row above is
      // already committed either way — a player the host typed belongs to the
      // play; the roster row is only for spectators.)
      if (d.code) {
        withLobby((code) => api.addParticipant(code, { userId: user_id || null, displayName: clean }))
          .then((updated) => {
            if (!updated) return;
            lobbyRef.current = updated;
            const part = (updated.participants || []).find((p) =>
              user_id
                ? p.user_id === user_id
                : !p.user_id && (p.display_name || '').toLowerCase() === clean.toLowerCase(),
            );
            if (part) mutate((dd) => {
              const row = dd.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
              if (row) row.participant_id = part.id;
            });
          });
      }
    },
    [mutate, maxRoundCount, withLobby],
  );

  const removePlayer = useCallback(
    (index) => {
      const d = draftRef.current;
      const p = d.players[index];
      if (!p) return;
      mutate((dd) => dd.players.splice(index, 1));
      if (p.participant_id && d.code) {
        pendingDeletesRef.current++;
        withLobby((code) => api.removeParticipant(code, p.participant_id)).finally(() => {
          pendingDeletesRef.current--;
        });
      }
    },
    [mutate, withLobby],
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
      if (liveRef.current && p.participant_id) {
        liveRef.current.setAnyScore(p.participant_id, roundIndex, parseRoundScore(clean)).catch(() => {});
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
      // Delete the round's live rows too. Spectators size their grid from
      // maxRound(), so leaving them behind keeps the removed round on screen
      // for everyone else — and the next poll would grow it back here.
      if (liveRef.current) liveRef.current.removeRoundAt(r).catch(() => {});
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
        if (isCoop(d.playMode)) {
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
      // No lobby to mirror into — an offline table, or a code that hasn't
      // landed yet. Either way the phase is local and the host moves on: the
      // session is what lets others watch, not what lets them play.
      if (d.offlineTable || !lobbyRef.current?.code) {
        setError(null);
        d.phase = next;
        persist();
        repaint();
        return true;
      }
      setError(null);
      const seq = ++phaseSeqRef.current;
      d.phase = next;
      persist();
      repaint();
      pendingPhaseRef.current++;
      try {
        const updated = await withLobby((code) => api.updateSessionPhase(code, next));
        if (seq !== phaseSeqRef.current) return true; // newer change owns state
        if (!updated) return true; // lobby is behind; the host is not
        lobbyRef.current = updated;
        if (updated.phase && updated.phase !== d.phase) {
          d.phase = updated.phase;
          persist();
          repaint();
        }
        if (next === 'play') startLiveScores();
        return true;
      } catch {
        // The phase the host is looking at is the truth; the lobby only
        // mirrors it. Rolling them back onto a screen they've left — for a
        // dead link OR a server refusal — is the one outcome that costs them
        // the game, and the save path falls back to the outbox regardless.
        // A lobby that's genuinely gone gets replaced by withLobby.
        return true;
      } finally {
        pendingPhaseRef.current--;
      }
    },
    [persist, repaint, startLiveScores, withLobby],
  );

  /**
   * A fresh lobby replaced a dead one mid-run. Everything keyed to the old
   * session has to follow it across, and none of it is load-bearing for the
   * play the host is recording — this only restores the live mirror.
   */
  const onLobbyReplaced = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    // participant_id on each local player points at the DEAD lobby's roster
    // rows, and the push below skips anyone who already has one — so without
    // clearing them the new lobby stays empty and spectators see a game with
    // no players.
    for (const p of d.players || []) p.participant_id = null;
    persist();

    // The old channel is subscribed to a session id that means nothing now.
    const live = liveRef.current;
    const hadLive = !!live;
    liveRef.current = null;
    if (live) Promise.resolve().then(() => live.stop()).catch(() => {});

    setCodeReplaced(true);
    repaint();

    // Order matters, and all three are best-effort:
    //   1. roster — participants are Gather-only, and a replacement is born in
    //      gather, so this has to land before the phase moves off it;
    //   2. phase — otherwise the new lobby sits in gather while the host
    //      plays, and anyone joining on the new code watches a lobby that
    //      never starts;
    //   3. live scores — RLS only accepts score writes while phase='play', so
    //      re-subscribing before step 2 would have its first mirror rejected.
    (async () => {
      const code = lobbyRef.current?.code;
      if (!code) return;
      await pushRosterToLobby();
      // bgb_advance_phase validates transitions, so walk rather than jump.
      const target = d.phase || 'gather';
      for (const step of PHASE_ORDER) {
        if (step === 'gather') continue;
        await api.updateSessionPhase(code, step).catch(() => {});
        if (step === target) break;
      }
      if (hadLive && d.phase === 'play') await startLiveScores();
      repaint();
    })().catch(() => {});
  }, [me, persist, repaint, startLiveScores, pushRosterToLobby]);
  onLobbyReplacedRef.current = onLobbyReplaced;

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
        userId: me?.id || null,
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
    [resolvedScore, me?.id],
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
      await pushRosterToLobby();
      repaint();
      pollRef.current = setInterval(lobbyPollTick, 2000);
      await startLiveScores();
    },
    [me, repaint, ensureLobbyOpen, pushRosterToLobby, lobbyPollTick, startLiveScores],
  );

  return {
    ready,
    error,
    saving,
    draft,
    lobby: lobbyRef.current,
    live: liveRef.current,
    lobbyFailed,
    codeReplaced,
    dismissCodeReplaced: () => setCodeReplaced(false),
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
