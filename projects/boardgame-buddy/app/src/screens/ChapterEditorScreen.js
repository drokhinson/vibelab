// ChapterEditorScreen — reference-guide chapter editor with two modes:
//   Browse — the per-game community pool (popularity-sorted); add to my guide
//            or report. Create/Edit — type + title + markdown body with a live
//   preview. Mirrors web/views/reference-guide-add-view.js. Transient form
//   state resets on every mount (web-frontend async-state rule).

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Plus, Check, Flag, Eye } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import Markdown from '../components/Markdown';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import { confirm, alert as alertModal } from '../components/ConfirmModal';
import api from '../api/client';

export default function ChapterEditorScreen({ navigation, route }) {
  const { gameId, gameName, expansionIds = [] } = route.params || {};
  const state = useAppState();
  const [tab, setTab] = useState('browse'); // 'browse' | 'create'
  const [pool, setPool] = useState(null);
  const [inGuide, setInGuide] = useState({});
  const [busyId, setBusyId] = useState(null);

  // Create-form state — reset on every mount.
  const [chapterType, setChapterType] = useState(state.chapterTypes[0]?.id || 'tips');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadPool = useCallback(async () => {
    try {
      const rows = await api.chapterPool(gameId, { expansionIds });
      setPool(rows || []);
      const m = {};
      (rows || []).forEach((r) => { if (r.in_my_guide) m[r.id] = true; });
      setInGuide(m);
    } catch { setPool([]); }
  }, [gameId, expansionIds.join(',')]);

  useEffect(() => { loadPool(); }, [loadPool]);

  async function toggleInGuide(ch) {
    setBusyId(ch.id);
    try {
      if (inGuide[ch.id]) { await api.removeChapter(gameId, ch.id); setInGuide((m) => ({ ...m, [ch.id]: false })); }
      else { await api.addChapter(gameId, ch.id); setInGuide((m) => ({ ...m, [ch.id]: true })); }
    } catch {}
    setBusyId(null);
  }

  async function report(ch) {
    const ok = await confirm({ title: 'Report this chapter?', body: 'A moderator will review it. Report offensive or incorrect content.', confirmLabel: 'Report' });
    if (!ok) return;
    try { await api.reportChapter(ch.id, null); await alertModal({ title: 'Reported', body: 'Thanks — a moderator will take a look.' }); } catch {}
  }

  async function saveNew() {
    if (!title.trim() || !content.trim()) { await alertModal({ title: 'Missing fields', body: 'Add a title and some content.' }); return; }
    setSaving(true);
    try {
      await api.createChapter(gameId, { chapter_type: chapterType, title: title.trim(), content: content.trim(), layout: 'text' });
      navigation.goBack();
    } catch (e) {
      await alertModal({ title: 'Save failed', body: e.message });
    }
    setSaving(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Reference guide" subtitle={gameName} onBack={() => navigation.goBack()} />
      <View style={styles.tabs}>
        <TabBtn label="Browse" active={tab === 'browse'} onPress={() => setTab('browse')} />
        <TabBtn label="Write new" active={tab === 'create'} onPress={() => setTab('create')} />
      </View>

      {tab === 'browse' ? (
        pool === null ? (
          <LoadingState label="Loading chapters…" />
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {pool.length === 0 ? (
              <EmptyState title="No chapters yet" body="Be the first to write one for this game." ctaLabel="Write a chapter" onCta={() => setTab('create')} />
            ) : (
              pool.map((ch) => (
                <View key={ch.id} style={styles.poolCard}>
                  <View style={styles.poolHead}>
                    <Text style={styles.poolTitle} numberOfLines={1}>{ch.title}</Text>
                    <Text style={styles.poolPop}>★ {ch.popularity || 0}</Text>
                  </View>
                  <Text style={styles.poolAuthor}>{ch.chapter_type} · by {ch.created_by_name || 'someone'}</Text>
                  <Markdown content={ch.content} style={styles.poolBody} />
                  <View style={styles.poolActions}>
                    <Pressable style={[styles.addBtn, inGuide[ch.id] && styles.addedBtn]} disabled={busyId === ch.id} onPress={() => toggleInGuide(ch)}>
                      {inGuide[ch.id] ? <Check size={15} color={COLORS.success} /> : <Plus size={15} color={COLORS.accent} />}
                      <Text style={[styles.addLabel, inGuide[ch.id] && { color: COLORS.success }]}>{inGuide[ch.id] ? 'In my guide' : 'Add to guide'}</Text>
                    </Pressable>
                    <Pressable style={styles.reportBtn} onPress={() => report(ch)} hitSlop={6}>
                      <Flag size={15} color={COLORS.textMuted} />
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        )
      ) : (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.typeRow}>
            {(state.chapterTypes.length ? state.chapterTypes : [{ id: 'tips', label: 'Tips' }]).map((t) => (
              <Pressable key={t.id} style={[styles.typeChip, chapterType === t.id && styles.typeChipOn]} onPress={() => setChapterType(t.id)}>
                <Text style={[styles.typeChipLabel, chapterType === t.id && styles.typeChipLabelOn]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.label}>Title</Text>
          <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Setup for 4 players" placeholderTextColor={COLORS.textMuted} />

          <View style={styles.contentHead}>
            <Text style={styles.label}>Content (Markdown)</Text>
            <Pressable style={styles.previewToggle} onPress={() => setPreview((v) => !v)}>
              <Eye size={14} color={COLORS.accent} />
              <Text style={styles.previewToggleLabel}>{preview ? 'Edit' : 'Preview'}</Text>
            </Pressable>
          </View>
          {preview ? (
            <View style={styles.previewBox}><Markdown content={content} /></View>
          ) : (
            <TextInput style={[styles.input, styles.textarea]} value={content} onChangeText={setContent} placeholder="Write the rule summary… **bold**, *italic*, - bullets" placeholderTextColor={COLORS.textMuted} multiline textAlignVertical="top" />
          )}

          <Pressable style={[styles.primary, saving && styles.disabled]} onPress={saveNew} disabled={saving}>
            {saving ? <ActivityIndicator color={COLORS.bg} /> : <Text style={styles.primaryLabel}>Publish chapter</Text>}
          </Pressable>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function TabBtn({ label, active, onPress }) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  tabs: { flexDirection: 'row', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm, gap: SPACING.sm },
  tab: { flex: 1, paddingVertical: 10, borderRadius: RADII.pill, alignItems: 'center', backgroundColor: COLORS.card },
  tabActive: { backgroundColor: COLORS.accent },
  tabLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.textSoft, fontSize: 14 },
  tabLabelActive: { color: COLORS.bg },
  body: { padding: SPACING.lg, paddingBottom: 60 },
  poolCard: { backgroundColor: COLORS.polaroidBg, borderRadius: RADII.lg, padding: SPACING.lg, marginBottom: SPACING.md },
  poolHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  poolTitle: { flex: 1, fontFamily: FONTS.display, color: COLORS.polaroidInk, fontSize: 18 },
  poolPop: { fontFamily: FONTS.score, color: COLORS.polaroidAccent, fontSize: 13 },
  poolAuthor: { fontFamily: FONTS.sans, color: COLORS.polaroidMuted, fontSize: 12, marginTop: 2 },
  poolBody: { marginTop: SPACING.sm },
  poolActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.md },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 14, borderRadius: RADII.pill, backgroundColor: COLORS.accent + '22' },
  addedBtn: { backgroundColor: COLORS.success + '22' },
  addLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 13 },
  reportBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: FONTS.sansSemibold, color: COLORS.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: SPACING.md },
  typeRow: { gap: SPACING.sm, paddingVertical: SPACING.sm },
  typeChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADII.pill, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border },
  typeChipOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  typeChipLabel: { fontFamily: FONTS.sansMedium, color: COLORS.textSoft, fontSize: 13 },
  typeChipLabelOn: { color: COLORS.bg },
  input: { backgroundColor: COLORS.card, borderRadius: RADII.md, paddingHorizontal: SPACING.md, paddingVertical: 11, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, marginTop: SPACING.sm, borderWidth: 1, borderColor: COLORS.border },
  textarea: { minHeight: 160 },
  contentHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: SPACING.md },
  previewToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  previewToggleLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.accent, fontSize: 13 },
  previewBox: { backgroundColor: COLORS.polaroidBg, borderRadius: RADII.md, padding: SPACING.md, marginTop: SPACING.sm, minHeight: 160 },
  primary: { backgroundColor: COLORS.accent, borderRadius: RADII.md, paddingVertical: 13, alignItems: 'center', marginTop: SPACING.xl },
  primaryLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 16 },
  disabled: { opacity: 0.6 },
});
