// ReferenceGuideScroll — the parchment reference-guide. Loads the user's
// per-game guide chapters (base + enabled expansions), shows them in
// collapsible cards with a colored source dot, and a "Add a chapter" entry
// that routes to the ChapterEditor. Ported from web/widgets/reference-guide-scroll.js.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { ScrollText, Plus, ChevronDown, ChevronRight } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import Markdown from '../components/Markdown';
import api from '../api/client';

export default function ReferenceGuideScroll({ gameId, gameName, expansionIds = [], onAddChapter, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [chapters, setChapters] = useState(null);
  const [expanded, setExpanded] = useState({});

  const load = useCallback(async () => {
    try {
      const rows = await api.myChapters(gameId, { expansionIds });
      setChapters(rows || []);
    } catch {
      setChapters([]);
    }
  }, [gameId, expansionIds.join(',')]);

  useEffect(() => { if (open && chapters === null) load(); }, [open, chapters, load]);

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.header} onPress={() => setOpen((v) => !v)}>
        <ScrollText size={18} color={COLORS.polaroidInk} />
        <Text style={styles.headerTitle}>Reference guide</Text>
        {open ? <ChevronDown size={18} color={COLORS.polaroidInkSoft} /> : <ChevronRight size={18} color={COLORS.polaroidInkSoft} />}
      </Pressable>

      {open ? (
        <View style={styles.scrollBody}>
          {chapters === null ? (
            <ActivityIndicator color={COLORS.polaroidAccent} style={{ paddingVertical: 16 }} />
          ) : chapters.length === 0 ? (
            <Text style={styles.empty}>No chapters in your guide yet. Add one from the community pool or write your own.</Text>
          ) : (
            chapters.map((ch) => (
              <View key={ch.id} style={styles.chapter}>
                <Pressable style={styles.chapterHead} onPress={() => setExpanded((e) => ({ ...e, [ch.id]: !e[ch.id] }))}>
                  {ch.source_color ? <View style={[styles.dot, { backgroundColor: ch.source_color }]} /> : null}
                  <Text style={styles.chapterTitle} numberOfLines={1}>{ch.title}</Text>
                  {expanded[ch.id] ? <ChevronDown size={16} color={COLORS.polaroidMuted} /> : <ChevronRight size={16} color={COLORS.polaroidMuted} />}
                </Pressable>
                {expanded[ch.id] ? <Markdown content={ch.content} style={styles.chapterBody} /> : null}
              </View>
            ))
          )}

          <Pressable style={styles.addBtn} onPress={onAddChapter}>
            <Plus size={16} color={COLORS.polaroidAccent} />
            <Text style={styles.addLabel}>Add a chapter</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: COLORS.polaroidBgSoft, borderRadius: RADII.lg, overflow: 'hidden', borderWidth: 1, borderColor: COLORS.polaroidLine },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: SPACING.md },
  headerTitle: { flex: 1, fontFamily: FONTS.display, color: COLORS.polaroidInk, fontSize: 18 },
  scrollBody: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.md },
  empty: { fontFamily: FONTS.polaroidItalic, color: COLORS.polaroidMuted, fontSize: 14, fontStyle: 'italic', paddingVertical: SPACING.sm },
  chapter: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.polaroidLine, paddingVertical: SPACING.sm },
  chapterHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  chapterTitle: { flex: 1, fontFamily: FONTS.sansSemibold, color: COLORS.polaroidInk, fontSize: 15 },
  chapterBody: { marginTop: SPACING.sm, paddingLeft: 2 },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: SPACING.md, paddingVertical: 10, borderRadius: RADII.md, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.polaroidAccent + '88' },
  addLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.polaroidAccent, fontSize: 14 },
});
