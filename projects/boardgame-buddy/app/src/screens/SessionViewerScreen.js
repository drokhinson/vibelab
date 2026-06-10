// SessionViewerScreen — the joiner's read-only mirror of a live session. Phase
// auto-advances via Supabase Realtime; the joiner can edit only their own
// scoring column. On finalize the host's Play is created and the viewer sees a
// wrap-up. Ported from web/views/session-viewer-view.js. Race guards: poll
// gated, fire-and-forget channel teardown, participant patch-in-place.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import UserBadge from '../components/UserBadge';
import RoundScoreGrid from '../widgets/RoundScoreGrid';
import ReferenceGuideScroll from '../widgets/ReferenceGuideScroll';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import { alert as alertModal } from '../components/ConfirmModal';
import LiveScores from '../realtime/liveScores';
import { subscribePhase } from '../realtime/sessionPhase';
import api from '../api/client';

export default function SessionViewerScreen({ navigation, route }) {
  const code = route.params?.code;
  const me = useAppState().currentUser;
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState('gather');
  const [rounds, setRounds] = useState(1);
  const liveRef = useRef(null);
  const [, tick] = useState(0);
  const finishedRef = useRef(false);

  // Load + poll session (gated by nothing here; viewer is read-only on roster).
  const loadSession = useCallback(async () => {
    try {
      const s = await api.session(code);
      setSession(s);
      if (s.phase) setPhase(s.phase);
      if ((s.phase === 'finalized') && !finishedRef.current) {
        finishedRef.current = true;
        await alertModal({ title: 'Game logged! 🎲', body: 'The host finalized this play. Check your feed.' });
        navigation.navigate('Home');
      }
    } catch {}
  }, [code]);

  useEffect(() => { loadSession(); }, [loadSession]);
  useEffect(() => {
    const id = setInterval(loadSession, 3000);
    return () => clearInterval(id);
  }, [loadSession]);

  // Realtime phase subscription (auto-advance the joiner's view).
  useEffect(() => {
    if (!session) return undefined;
    const off = subscribePhase(session.id, (newPhase) => {
      setPhase(newPhase);
      if (newPhase === 'finalized' && !finishedRef.current) {
        finishedRef.current = true;
        alertModal({ title: 'Game logged! 🎲', body: 'The host finalized this play.' }).then(() => navigation.navigate('Home'));
      }
    });
    return () => { Promise.resolve().then(off).catch(() => {}); };
  }, [session?.id]);

  // Live scores once playing.
  useEffect(() => {
    if (phase !== 'play' || !session) return undefined;
    const live = new LiveScores({ sessionId: session.id, isHost: false, currentUserId: me.id });
    liveRef.current = live;
    let off = null;
    live.start().then(() => {
      off = live.subscribe(() => { setRounds((r) => Math.max(r, live.maxRound() + 1)); tick((t) => t + 1); });
    });
    return () => {
      if (off) off();
      Promise.resolve().then(() => live.stop()).catch(() => {});
      liveRef.current = null;
    };
  }, [phase, session?.id]);

  if (!session) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title="Session" onBack={() => navigation.goBack()} />
        <LoadingState label="Joining…" />
      </SafeAreaView>
    );
  }

  const participants = session.participants || [];
  // Build players list from participants; the viewer's own column is editable.
  const players = participants.map((p) => ({
    key: p.user_id || p.id,
    name: p.display_name,
    user_id: p.user_id || null,
    avatar: p.avatar || null,
  }));
  const live = liveRef.current;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title={`Session · ${code}`} subtitle={cap(phase)} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body}>
        {session.game ? <GameTile game={session.game} variant="thumb" showStatus={false} /> : null}

        {phase === 'gather' ? (
          <View style={styles.section}>
            <Text style={styles.title}>Waiting for the host to start…</Text>
            <Text style={styles.sub}>Players at the table</Text>
            <View style={styles.roster}>
              {players.map((p) => (
                <View key={p.key} style={styles.rosterChip}>
                  <UserBadge avatar={p.avatar} displayName={p.name} size="xs" isGhost={!p.user_id} isMe={p.user_id === me.id} />
                  <Text style={styles.rosterName}>{p.name}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {phase === 'play' && live ? (
          <View style={styles.section}>
            <Text style={styles.hint}>Enter your own scores — the host sees them live.</Text>
            <RoundScoreGrid
              players={players}
              rounds={rounds}
              getCell={(pi, ri) => live.getScore(players[pi].user_id, ri)}
              getTotal={(pi) => live.totalFor(players[pi].user_id)}
              canEditColumn={(pi) => players[pi].user_id === me.id}
              onSetCell={(pi, ri, v) => { if (players[pi].user_id === me.id) live.setMyScore(ri, v).catch(() => {}); }}
              editable
            />
            {session.game ? <ReferenceGuideScroll gameId={session.game.id} gameName={session.game.name} /> : null}
          </View>
        ) : null}

        {phase === 'settle' ? (
          <EmptyState title="Wrapping up" body="The host is settling the final scores. Hang tight — your play will be logged shortly." />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, gap: SPACING.lg },
  section: { gap: SPACING.md },
  title: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 20, textAlign: 'center' },
  sub: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 13, marginTop: SPACING.sm },
  hint: { fontFamily: FONTS.sans, color: COLORS.textSoft, fontSize: 13 },
  roster: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  rosterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.card, paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADII.pill, borderWidth: 1, borderColor: COLORS.borderSoft },
  rosterName: { fontFamily: FONTS.sansMedium, color: COLORS.text, fontSize: 13 },
});
