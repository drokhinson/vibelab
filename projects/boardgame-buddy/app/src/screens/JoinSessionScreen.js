// JoinSessionScreen — enter a 5-char code or pick from buddies' live sessions.
// Mirrors web/views/join-session-view.js. On join → SessionViewer (or PlayFlow
// if you turn out to be the host, resolved by SessionRouter).

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LogIn, Radio } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import UserBadge from '../components/UserBadge';
import EmptyState from '../components/EmptyState';
import { alert as alertModal } from '../components/ConfirmModal';
import api from '../api/client';

export default function JoinSessionScreen({ navigation }) {
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [sessions, setSessions] = useState(null);

  const load = useCallback(async () => {
    try { const r = await api.joinableSessions(); setSessions(r.sessions || []); } catch { setSessions([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function join(c) {
    const clean = (c || '').trim().toUpperCase();
    if (clean.length < 4) { await alertModal({ title: 'Invalid code', body: 'Enter the 5-character session code.' }); return; }
    setJoining(true);
    try {
      await api.joinSession(clean);
      navigation.replace('SessionRouter', { code: clean });
    } catch (e) {
      await alertModal({ title: "Couldn't join", body: e.message });
    }
    setJoining(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Join a game" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Session code</Text>
        <View style={styles.codeRow}>
          <TextInput
            style={styles.codeInput}
            value={code}
            onChangeText={(t) => setCode(t.toUpperCase())}
            placeholder="ABC12"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={6}
          />
          <Pressable style={[styles.joinBtn, joining && styles.disabled]} onPress={() => join(code)} disabled={joining}>
            {joining ? <ActivityIndicator color={COLORS.bg} /> : (<><LogIn size={18} color={COLORS.bg} /><Text style={styles.joinLabel}>Join</Text></>)}
          </Pressable>
        </View>

        <View style={styles.liveHead}>
          <Radio size={16} color={COLORS.accent} />
          <Text style={styles.sectionTitle}>Live sessions</Text>
        </View>
        {sessions === null ? (
          <ActivityIndicator color={COLORS.accent} style={{ marginTop: 20 }} />
        ) : sessions.length === 0 ? (
          <EmptyState icon={Radio} title="No live games" body="When a buddy starts hosting, their session shows up here." />
        ) : (
          sessions.map((s) => (
            <Pressable key={s.code} style={styles.sessionRow} onPress={() => join(s.code)}>
              <UserBadge avatar={s.host_avatar} displayName={s.host_display_name} size="md" />
              <View style={{ flex: 1 }}>
                <Text style={styles.hostName}>{s.host_display_name}</Text>
                <Text style={styles.gameName}>{s.game?.name || 'Choosing a game…'}</Text>
              </View>
              <Text style={styles.code}>{s.code}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg },
  label: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  codeRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  codeInput: { flex: 1, backgroundColor: COLORS.card, borderRadius: RADII.md, paddingHorizontal: SPACING.md, paddingVertical: 12, color: COLORS.text, fontFamily: FONTS.scoreBold, fontSize: 22, letterSpacing: 4, textAlign: 'center', borderWidth: 1, borderColor: COLORS.border },
  joinBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.accent, borderRadius: RADII.md, paddingHorizontal: SPACING.lg, justifyContent: 'center' },
  joinLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 15 },
  disabled: { opacity: 0.6 },
  liveHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.xl, marginBottom: SPACING.sm },
  sectionTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, backgroundColor: COLORS.card, borderRadius: RADII.md, padding: SPACING.md, marginBottom: SPACING.sm, borderWidth: 1, borderColor: COLORS.borderSoft },
  hostName: { fontFamily: FONTS.sansSemibold, color: COLORS.text, fontSize: 15 },
  gameName: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 13, marginTop: 1 },
  code: { fontFamily: FONTS.scoreBold, color: COLORS.accent, fontSize: 16, letterSpacing: 2 },
});
