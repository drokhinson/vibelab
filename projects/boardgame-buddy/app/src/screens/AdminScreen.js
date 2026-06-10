// AdminScreen — chapter-report moderation. Resolve a report or delete the
// offending chapter (via ConfirmModal). Admin-only. Mirrors web/views/admin-view.js.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, Trash2, ShieldCheck } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import { confirm } from '../components/ConfirmModal';
import api from '../api/client';

export default function AdminScreen({ navigation }) {
  const [reports, setReports] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try { setReports(await api.adminChapterReports('open')); } catch { setReports([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function resolve(id) {
    setBusyId(id);
    try { await api.adminResolveReport(id); await load(); } catch {}
    setBusyId(null);
  }
  async function removeChapter(r) {
    const ok = await confirm({ title: 'Delete this chapter?', body: `"${r.chapter_title}" will be removed from every guide. This cannot be undone.`, confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    setBusyId(r.id);
    try { await api.deleteChapter(r.chapter_id); await api.adminResolveReport(r.id).catch(() => {}); await load(); } catch {}
    setBusyId(null);
  }

  if (reports === null) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader title="Moderation" onBack={() => navigation.goBack()} />
        <LoadingState label="Loading reports…" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Moderation" onBack={() => navigation.goBack()} />
      <FlatList
        data={reports}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        renderItem={({ item: r }) => (
          <View style={styles.card}>
            <Text style={styles.gameName}>{r.game_name}</Text>
            <Text style={styles.chapterTitle}>{r.chapter_title}</Text>
            <Text style={styles.preview} numberOfLines={3}>{r.chapter_content_preview}</Text>
            {r.reason ? <Text style={styles.reason}>Reason: {r.reason}</Text> : null}
            <Text style={styles.reporter}>Reported by {r.reporter_name || 'someone'}</Text>
            <View style={styles.actions}>
              <Pressable style={styles.resolveBtn} disabled={busyId === r.id} onPress={() => resolve(r.id)}>
                <Check size={15} color={COLORS.success} />
                <Text style={[styles.actionLabel, { color: COLORS.success }]}>Dismiss</Text>
              </Pressable>
              <Pressable style={styles.deleteBtn} disabled={busyId === r.id} onPress={() => removeChapter(r)}>
                <Trash2 size={15} color={COLORS.rustText} />
                <Text style={[styles.actionLabel, { color: COLORS.rustText }]}>Delete chapter</Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={<EmptyState icon={ShieldCheck} title="All clear" body="No open chapter reports." />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  list: { padding: SPACING.lg, gap: SPACING.md },
  card: { backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.borderSoft },
  gameName: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12 },
  chapterTitle: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 18, marginTop: 2 },
  preview: { fontFamily: FONTS.sans, color: COLORS.textSoft, fontSize: 13, lineHeight: 19, marginTop: SPACING.sm },
  reason: { fontFamily: FONTS.sansMedium, color: COLORS.rustText, fontSize: 13, marginTop: SPACING.sm },
  reporter: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  actions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  resolveBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 12, borderRadius: RADII.pill, backgroundColor: COLORS.success + '22' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 12, borderRadius: RADII.pill, backgroundColor: COLORS.rust + '22' },
  actionLabel: { fontFamily: FONTS.sansSemibold, fontSize: 13 },
});
