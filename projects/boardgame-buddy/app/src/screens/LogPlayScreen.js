// LogPlayScreen — the Play tab landing: Host-or-Join chooser + "resume hosting"
// banner from a persisted draft. Mirrors web/views/log-play-view.js. Hosting a
// game creates a live session and routes into the PlayFlow cascade.

import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Dices, LogIn, Play } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';
import EmptyState from '../components/EmptyState';
import { loadDraft } from '../models/playSession';
import api from '../api/client';

export default function LogPlayScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const me = state.currentUser;
  const [draft, setDraft] = useState(null);
  const [creating, setCreating] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      loadDraft().then((d) => active && setDraft(d && d.sessionId ? d : null));
      if (me) actions.refreshHostSeeds();
      return () => { active = false; };
    }, [me]),
  );

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <EmptyState icon={Dices} title="Log a play" body="Sign in to host or join a game session." ctaLabel="Sign in" onCta={() => navigation.navigate('Auth')} />
      </SafeAreaView>
    );
  }

  async function host() {
    setCreating(true);
    try {
      const session = await api.createSession(null);
      navigation.navigate('PlayFlow', { code: session.code });
    } catch {}
    setCreating(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Log a play</Text>
        <Text style={styles.subtitle}>Host a session at your table, or join one by code.</Text>

        {draft ? (
          <Pressable style={styles.resume} onPress={() => navigation.navigate('PlayFlow', { code: draft.code })}>
            <Play size={20} color={COLORS.bg} fill={COLORS.bg} />
            <View style={{ flex: 1 }}>
              <Text style={styles.resumeTitle}>Resume hosting</Text>
              <Text style={styles.resumeSub}>{draft.game?.name || 'Session in progress'}</Text>
            </View>
          </Pressable>
        ) : null}

        <Pressable style={[styles.bigBtn, styles.hostBtn, creating && styles.disabled]} onPress={host} disabled={creating}>
          {creating ? <ActivityIndicator color={COLORS.bg} /> : <Dices size={28} color={COLORS.bg} />}
          <Text style={styles.hostLabel}>Host a game</Text>
          <Text style={styles.hostSub}>Start a session — invite players by code</Text>
        </Pressable>

        <Pressable style={[styles.bigBtn, styles.joinBtn]} onPress={() => navigation.navigate('JoinSession')}>
          <LogIn size={28} color={COLORS.accent} />
          <Text style={styles.joinLabel}>Join a game</Text>
          <Text style={styles.joinSub}>Enter a code or pick a live session</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg, paddingTop: SPACING.xl },
  title: { fontFamily: FONTS.displayBold, color: COLORS.text, fontSize: 28 },
  subtitle: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 14, marginTop: 4, marginBottom: SPACING.xl },
  resume: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, backgroundColor: COLORS.accent, borderRadius: RADII.lg, padding: SPACING.lg, marginBottom: SPACING.lg },
  resumeTitle: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 16 },
  resumeSub: { fontFamily: FONTS.sans, color: COLORS.bg, fontSize: 13, opacity: 0.85 },
  bigBtn: { borderRadius: RADII.xl, padding: SPACING.xl, alignItems: 'center', gap: 6, marginBottom: SPACING.lg },
  hostBtn: { backgroundColor: COLORS.accent },
  hostLabel: { fontFamily: FONTS.displayBold, color: COLORS.bg, fontSize: 22, marginTop: SPACING.sm },
  hostSub: { fontFamily: FONTS.sans, color: COLORS.bg, fontSize: 13, opacity: 0.85, textAlign: 'center' },
  joinBtn: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.accent + '66' },
  joinLabel: { fontFamily: FONTS.displayBold, color: COLORS.text, fontSize: 22, marginTop: SPACING.sm },
  joinSub: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13, textAlign: 'center' },
  disabled: { opacity: 0.7 },
});
