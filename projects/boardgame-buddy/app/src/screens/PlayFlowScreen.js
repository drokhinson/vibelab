// PlayFlowScreen — the host's live play cascade: Gather → Play → Settle. Picks
// a game, gathers players (buddies / ghosts / recent + manual), runs live
// round-by-round scoring (Supabase Realtime so joiners see + edit their own
// column), then settles (photo + notes + winners) and finalizes into a Play.
// Ported from web/views/play-flow-view.js. Race guards (phase seq, poll gate)
// carried over from .claude/rules/web-frontend.md.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Camera, UserPlus, X, ArrowRight, Check } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import UserBadge from '../components/UserBadge';
import GameTile from '../components/GameTile';
import GameFinder from '../widgets/GameFinder';
import RoundScoreGrid from '../widgets/RoundScoreGrid';
import ReferenceGuideScroll from '../widgets/ReferenceGuideScroll';
import LoadingState from '../components/LoadingState';
import { confirm, alert as alertModal } from '../components/ConfirmModal';
import { saveDraft, clearDraft, toPlayPayload } from '../models/playSession';
import LiveScores from '../realtime/liveScores';
import api from '../api/client';

const PHASES = ['gather', 'play', 'settle'];

export default function PlayFlowScreen({ navigation, route }) {
  const code = route.params?.code;
  const state = useAppState();
  const actions = useAppActions();
  const me = state.currentUser;

  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState('gather');
  const [game, setGame] = useState(null);
  const [players, setPlayers] = useState([]); // {key,name,user_id,avatar,is_winner}
  const [rounds, setRounds] = useState(1);
  const [scores, setScores] = useState({}); // { [key]: { [roundIdx]: value } }
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState(null);
  const [playMode, setPlayMode] = useState('competitive');
  const [pickingGame, setPickingGame] = useState(false);
  const [ghostName, setGhostName] = useState('');
  const [finalizing, setFinalizing] = useState(false);

  const phaseSeqRef = useRef(0);
  const pendingPhaseRef = useRef(0);
  const liveRef = useRef(null);
  const [, forceTick] = useState(0);

  // ── Load session + seed host as first player ──────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const s = await api.session(code);
        if (!active) return;
        setSession(s);
        setPhase(s.phase && s.phase !== 'finalized' && s.phase !== 'abandoned' ? s.phase : 'gather');
        if (s.game) setGame(s.game);
        setPlayers((prev) => (prev.length ? prev : [{ key: me.id, name: me.display_name, user_id: me.id, avatar: me.avatar, is_winner: false }]));
      } catch (e) {
        await alertModal({ title: 'Session error', body: e.message });
        navigation.goBack();
      }
    })();
    return () => { active = false; };
  }, [code]);

  // ── Lobby poll (gated while a phase change is in flight) ───────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      if (pendingPhaseRef.current > 0) return; // don't clobber optimistic state
      try {
        const s = await api.session(code);
        setSession(s);
      } catch {}
    }, 3000);
    return () => clearInterval(id);
  }, [code]);

  // ── Live scores during Play phase ──────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'play' || !session) return undefined;
    const live = new LiveScores({ sessionId: session.id, isHost: true, currentUserId: me.id });
    liveRef.current = live;
    let off = null;
    live.start().then(() => {
      off = live.subscribe(() => {
        // Merge joiner cells into local score map for user-linked players.
        setScores((prev) => {
          const next = { ...prev };
          players.forEach((p) => {
            if (!p.user_id) return;
            const max = live.maxRound();
            const col = { ...(next[p.key] || {}) };
            for (let r = 0; r <= max; r++) {
              const v = live.getScore(p.user_id, r);
              if (v != null) col[r] = v;
            }
            next[p.key] = col;
          });
          return next;
        });
        setRounds((r) => Math.max(r, live.maxRound() + 1));
        forceTick((t) => t + 1);
      });
    });
    return () => {
      if (off) off();
      // Fire-and-forget teardown so navigation never freezes.
      Promise.resolve().then(() => live.stop()).catch(() => {});
      liveRef.current = null;
    };
  }, [phase, session?.id]);

  // Persist draft on meaningful change.
  useEffect(() => {
    if (!session) return;
    saveDraft({ code, sessionId: session.id, hostUserId: me.id, phase, game, players, expansionIds: [], playMode, notes });
  }, [session, phase, game, players, playMode, notes]);

  // ── Phase transitions (sequence-guarded) ──────────────────────────────────
  const goToPhase = useCallback(
    async (next) => {
      const seq = ++phaseSeqRef.current;
      pendingPhaseRef.current += 1;
      setPhase(next); // optimistic
      try {
        await api.updateSessionPhase(code, next);
      } catch (e) {
        if (seq === phaseSeqRef.current) {
          // roll back
          setPhase((p) => p);
          await alertModal({ title: "Couldn't advance", body: e.message });
        }
      } finally {
        pendingPhaseRef.current = Math.max(0, pendingPhaseRef.current - 1);
      }
    },
    [code],
  );

  async function pickGame(g) {
    setGame(g);
    setPickingGame(false);
    try { await api.updateSession(code, g.id); } catch {}
  }

  function addPlayer(p) {
    setPlayers((prev) => {
      if (p.user_id && prev.some((x) => x.user_id === p.user_id)) return prev;
      return [...prev, { key: p.user_id || `ghost-${p.name}-${prev.length}`, name: p.name, user_id: p.user_id || null, avatar: p.avatar || null, is_winner: false }];
    });
    if (p.user_id) api.addParticipant(code, { userId: p.user_id, displayName: p.name }).catch(() => {});
  }
  function addGhost() {
    const name = ghostName.trim();
    if (!name) return;
    addPlayer({ name });
    setGhostName('');
  }
  function removePlayer(key) {
    setPlayers((prev) => prev.filter((p) => p.key !== key));
  }

  function setCell(playerIdx, roundIdx, value) {
    const p = players[playerIdx];
    setScores((prev) => ({ ...prev, [p.key]: { ...(prev[p.key] || {}), [roundIdx]: value } }));
    // Push user-linked scores to Realtime so joiners see the host's edits.
    if (p.user_id && liveRef.current) liveRef.current.setAnyScore(p.user_id, roundIdx, value).catch(() => {});
  }
  function getCell(playerIdx, roundIdx) {
    const p = players[playerIdx];
    const v = scores[p.key] && scores[p.key][roundIdx];
    return v == null ? null : v;
  }
  function getTotal(playerIdx) {
    const p = players[playerIdx];
    const col = scores[p.key] || {};
    return Object.values(col).reduce((s, v) => s + (Number(v) || 0), 0);
  }
  function toggleWinner(playerIdx) {
    setPlayers((prev) => prev.map((p, i) => (i === playerIdx ? { ...p, is_winner: !p.is_winner } : p)));
  }

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { await alertModal({ title: 'Permission needed', body: 'Allow photo access to attach a snapshot.' }); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, allowsEditing: true });
    if (!res.canceled && res.assets && res.assets[0]) {
      setPhoto({ uri: res.assets[0].uri, name: 'play.jpg', type: 'image/jpeg' });
    }
  }

  async function abandon() {
    const ok = await confirm({ title: 'Abandon this session?', body: 'Nobody will be able to join, and nothing will be logged. This cannot be undone.', confirmLabel: 'Abandon', destructive: true });
    if (!ok) return;
    try { await api.abandonSession(code); } catch {}
    await clearDraft();
    navigation.navigate('Home');
  }

  async function finalize() {
    if (!game) { await alertModal({ title: 'Pick a game', body: 'Choose the game you played first.' }); return; }
    setFinalizing(true);
    try {
      let photoUrl = null;
      if (photo) {
        try { const up = await api.uploadPlayPhoto(photo); photoUrl = up.photo_url; } catch {}
      }
      const draft = { game, players: players.map((p) => ({ ...p, round_scores: roundsToArray(scores[p.key], rounds) })), notes, playMode, expansionIds: [], photoUrl };
      const payload = toPlayPayload(draft, {});
      await api.finalizeSession(code, payload);
      await clearDraft();
      actions.refreshFeed();
      actions.refreshHostSeeds();
      const winners = players.filter((p) => p.is_winner).map((p) => p.name);
      await alertModal({ title: winners.length ? `${winners.join(' & ')} won! 🏆` : 'Play logged', body: `Your game of ${game.name} is saved.` });
      navigation.navigate('Home');
    } catch (e) {
      await alertModal({ title: 'Finalize failed', body: e.message });
    }
    setFinalizing(false);
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title="Hosting" onBack={() => navigation.goBack()} />
        <LoadingState label="Opening lobby…" />
      </SafeAreaView>
    );
  }

  const phaseIdx = PHASES.indexOf(phase);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title={`Hosting · ${code}`} subtitle={PHASES[phaseIdx] ? cap(PHASES[phaseIdx]) : ''} onBack={abandon} />
      <Stepper idx={phaseIdx} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {phase === 'gather' ? (
          <GatherPhase
            game={game}
            pickingGame={pickingGame}
            setPickingGame={setPickingGame}
            onPickGame={pickGame}
            players={players}
            removePlayer={removePlayer}
            addPlayer={addPlayer}
            ghostName={ghostName}
            setGhostName={setGhostName}
            addGhost={addGhost}
            partners={state.playPartners}
            code={code}
          />
        ) : null}

        {phase === 'play' ? (
          <View style={{ gap: SPACING.lg }}>
            {game ? <GameTile game={game} variant="thumb" showStatus={false} /> : null}
            <RoundScoreGrid
              players={players}
              rounds={rounds}
              getCell={getCell}
              getTotal={getTotal}
              isWinner={(i) => players[i].is_winner}
              onSetCell={setCell}
              onAddRound={() => setRounds((r) => r + 1)}
              onRemoveRound={() => setRounds((r) => Math.max(1, r - 1))}
              onToggleWinner={toggleWinner}
            />
            {game ? (
              <ReferenceGuideScroll gameId={game.id} gameName={game.name} onAddChapter={() => navigation.navigate('ChapterEditor', { gameId: game.id, gameName: game.name })} />
            ) : null}
          </View>
        ) : null}

        {phase === 'settle' ? (
          <SettlePhase
            game={game}
            players={players}
            getTotal={getTotal}
            toggleWinner={toggleWinner}
            photo={photo}
            pickPhoto={pickPhoto}
            notes={notes}
            setNotes={setNotes}
            playMode={playMode}
            setPlayMode={setPlayMode}
          />
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {phaseIdx > 0 ? (
          <Pressable style={styles.backBtn} onPress={() => goToPhase(PHASES[phaseIdx - 1])}>
            <Text style={styles.backLabel}>Back</Text>
          </Pressable>
        ) : <View style={{ flex: 1 }} />}
        {phase !== 'settle' ? (
          <Pressable
            style={[styles.nextBtn, (!game && phase === 'gather') && styles.disabled]}
            disabled={!game && phase === 'gather'}
            onPress={() => goToPhase(PHASES[phaseIdx + 1])}
          >
            <Text style={styles.nextLabel}>{phase === 'gather' ? 'Start playing' : 'Settle up'}</Text>
            <ArrowRight size={18} color={COLORS.bg} />
          </Pressable>
        ) : (
          <Pressable style={[styles.nextBtn, finalizing && styles.disabled]} onPress={finalize} disabled={finalizing}>
            {finalizing ? <ActivityIndicator color={COLORS.bg} /> : (<><Check size={18} color={COLORS.bg} /><Text style={styles.nextLabel}>Log play</Text></>)}
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function roundsToArray(col, rounds) {
  if (!col) return null;
  const arr = [];
  for (let r = 0; r < rounds; r++) arr.push(col[r] != null && col[r] !== '' ? Number(col[r]) : null);
  return arr.some((v) => v != null) ? arr : null;
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function Stepper({ idx }) {
  return (
    <View style={styles.stepper}>
      {PHASES.map((p, i) => (
        <View key={p} style={styles.step}>
          <View style={[styles.dot, i <= idx && styles.dotActive]}>
            <Text style={[styles.dotNum, i <= idx && styles.dotNumActive]}>{i + 1}</Text>
          </View>
          <Text style={[styles.stepLabel, i === idx && styles.stepLabelActive]}>{cap(p)}</Text>
          {i < PHASES.length - 1 ? <View style={[styles.connector, i < idx && styles.connectorActive]} /> : null}
        </View>
      ))}
    </View>
  );
}

function GatherPhase({ game, pickingGame, setPickingGame, onPickGame, players, removePlayer, addPlayer, ghostName, setGhostName, addGhost, partners, code }) {
  const added = new Set(players.filter((p) => p.user_id).map((p) => p.user_id));
  const suggestions = [];
  (partners.accounts || []).forEach((a) => !added.has(a.other_user_id) && suggestions.push({ user_id: a.other_user_id, name: a.other_display_name, avatar: a.other_avatar }));
  (partners.recent || []).forEach((r) => !added.has(r.user_id) && !suggestions.some((s) => s.user_id === r.user_id) && suggestions.push({ user_id: r.user_id, name: r.display_name, avatar: r.avatar }));

  return (
    <View style={{ gap: SPACING.lg }}>
      <View style={styles.codeBanner}>
        <Text style={styles.codeBannerLabel}>Share this code so others can join</Text>
        <Text style={styles.codeBannerCode}>{code}</Text>
      </View>

      <View>
        <Text style={styles.phaseTitle}>Game</Text>
        {game && !pickingGame ? (
          <Pressable onPress={() => setPickingGame(true)}>
            <GameTile game={game} variant="thumb" showStatus={false} onPress={() => setPickingGame(true)} />
            <Text style={styles.changeLink}>Change game</Text>
          </Pressable>
        ) : (
          <GameFinder includeRecentlyPlayed onPick={onPickGame} placeholder="What are you playing?" />
        )}
      </View>

      <View>
        <Text style={styles.phaseTitle}>Players ({players.length})</Text>
        <View style={styles.playerChips}>
          {players.map((p) => (
            <View key={p.key} style={styles.playerChip}>
              <UserBadge avatar={p.avatar} displayName={p.name} size="xs" isGhost={!p.user_id} />
              <Text style={styles.playerChipName} numberOfLines={1}>{p.name}</Text>
              <Pressable onPress={() => removePlayer(p.key)} hitSlop={6}><X size={14} color={COLORS.textMuted} /></Pressable>
            </View>
          ))}
        </View>

        <View style={styles.ghostRow}>
          <TextInput style={styles.ghostInput} value={ghostName} onChangeText={setGhostName} placeholder="Add a player by name…" placeholderTextColor={COLORS.textMuted} onSubmitEditing={addGhost} />
          <Pressable style={styles.ghostAdd} onPress={addGhost}><UserPlus size={18} color={COLORS.bg} /></Pressable>
        </View>

        {suggestions.length ? (
          <>
            <Text style={styles.subLabel}>Quick add</Text>
            <View style={styles.playerChips}>
              {suggestions.slice(0, 8).map((s) => (
                <Pressable key={s.user_id} style={styles.suggestChip} onPress={() => addPlayer(s)}>
                  <UserBadge avatar={s.avatar} displayName={s.name} size="xs" />
                  <Text style={styles.suggestName} numberOfLines={1}>{s.name}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

function SettlePhase({ game, players, getTotal, toggleWinner, photo, pickPhoto, notes, setNotes, playMode, setPlayMode }) {
  return (
    <View style={{ gap: SPACING.lg }}>
      {game ? <GameTile game={game} variant="thumb" showStatus={false} /> : null}

      <View>
        <Text style={styles.phaseTitle}>Mode</Text>
        <View style={styles.modeRow}>
          {['competitive', 'cooperative', 'team'].map((m) => (
            <Pressable key={m} style={[styles.modeChip, playMode === m && styles.modeChipOn]} onPress={() => setPlayMode(m)}>
              <Text style={[styles.modeLabel, playMode === m && styles.modeLabelOn]}>{cap(m)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <Text style={styles.phaseTitle}>Winners — tap to crown</Text>
        <View style={styles.winnerList}>
          {players.map((p, i) => (
            <Pressable key={p.key} style={[styles.winnerRow, p.is_winner && styles.winnerRowOn]} onPress={() => toggleWinner(i)}>
              <UserBadge avatar={p.avatar} displayName={p.name} size="sm" isGhost={!p.user_id} />
              <Text style={[styles.winnerName, p.is_winner && styles.winnerNameOn]}>{p.name}</Text>
              <Text style={styles.winnerScore}>{getTotal(i)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <Text style={styles.phaseTitle}>Snapshot</Text>
        <Pressable style={styles.photoBtn} onPress={pickPhoto}>
          {photo ? (
            <Image source={{ uri: photo.uri }} style={styles.photoPreview} />
          ) : (
            <View style={styles.photoEmpty}>
              <Camera size={28} color={COLORS.textMuted} />
              <Text style={styles.photoEmptyLabel}>Add a photo of the table</Text>
            </View>
          )}
        </Pressable>
      </View>

      <View>
        <Text style={styles.phaseTitle}>Notes</Text>
        <TextInput style={styles.notesInput} value={notes} onChangeText={setNotes} placeholder="A memorable moment, a house rule…" placeholderTextColor={COLORS.textMuted} multiline textAlignVertical="top" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 100 },
  stepper: { flexDirection: 'row', justifyContent: 'center', paddingVertical: SPACING.md, paddingHorizontal: SPACING.lg },
  step: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  dotActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  dotNum: { fontFamily: FONTS.scoreBold, color: COLORS.textMuted, fontSize: 13 },
  dotNumActive: { color: COLORS.bg },
  stepLabel: { fontFamily: FONTS.sansMedium, color: COLORS.textMuted, fontSize: 12, marginLeft: 5 },
  stepLabelActive: { color: COLORS.accent, fontFamily: FONTS.sansBold },
  connector: { width: 24, height: 2, backgroundColor: COLORS.border, marginHorizontal: 6 },
  connectorActive: { backgroundColor: COLORS.accent },
  phaseTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginBottom: SPACING.sm },
  subLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12, marginTop: SPACING.md, marginBottom: SPACING.xs },
  codeBanner: { backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.lg, alignItems: 'center', borderWidth: 1, borderColor: COLORS.accent + '44' },
  codeBannerLabel: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13 },
  codeBannerCode: { fontFamily: FONTS.scoreBold, color: COLORS.accent, fontSize: 34, letterSpacing: 6, marginTop: 4 },
  changeLink: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 13, marginTop: 6 },
  playerChips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  playerChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.card, paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADII.pill, borderWidth: 1, borderColor: COLORS.borderSoft, maxWidth: 160 },
  playerChipName: { fontFamily: FONTS.sansMedium, color: COLORS.text, fontSize: 13, maxWidth: 96 },
  suggestChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.bgElevated, paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADII.pill, borderWidth: 1, borderColor: COLORS.accent + '44' },
  suggestName: { fontFamily: FONTS.sansMedium, color: COLORS.textSoft, fontSize: 13, maxWidth: 96 },
  ghostRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  ghostInput: { flex: 1, backgroundColor: COLORS.card, borderRadius: RADII.md, paddingHorizontal: SPACING.md, paddingVertical: 11, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, borderWidth: 1, borderColor: COLORS.border },
  ghostAdd: { width: 48, backgroundColor: COLORS.accent, borderRadius: RADII.md, alignItems: 'center', justifyContent: 'center' },
  modeRow: { flexDirection: 'row', gap: SPACING.sm },
  modeChip: { flex: 1, paddingVertical: 10, borderRadius: RADII.pill, alignItems: 'center', backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border },
  modeChipOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  modeLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textSoft, fontSize: 13 },
  modeLabelOn: { color: COLORS.bg },
  winnerList: { gap: SPACING.xs },
  winnerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, padding: SPACING.sm, borderRadius: RADII.md, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.borderSoft },
  winnerRowOn: { borderColor: COLORS.accent, backgroundColor: COLORS.accent + '1a' },
  winnerName: { flex: 1, fontFamily: FONTS.sansMedium, color: COLORS.text, fontSize: 15 },
  winnerNameOn: { fontFamily: FONTS.sansBold, color: COLORS.accent },
  winnerScore: { fontFamily: FONTS.scoreBold, color: COLORS.text, fontSize: 16 },
  photoBtn: { borderRadius: RADII.lg, overflow: 'hidden' },
  photoPreview: { width: '100%', height: 200, borderRadius: RADII.lg },
  photoEmpty: { height: 120, borderRadius: RADII.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center', gap: 6 },
  photoEmptyLabel: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13 },
  notesInput: { backgroundColor: COLORS.card, borderRadius: RADII.md, padding: SPACING.md, minHeight: 90, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, borderWidth: 1, borderColor: COLORS.border },
  footer: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, padding: SPACING.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, backgroundColor: COLORS.bg },
  backBtn: { paddingVertical: 12, paddingHorizontal: SPACING.lg },
  backLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textSoft, fontSize: 15 },
  nextBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.accent, borderRadius: RADII.pill, paddingVertical: 14 },
  nextLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 16 },
  disabled: { opacity: 0.5 },
});
