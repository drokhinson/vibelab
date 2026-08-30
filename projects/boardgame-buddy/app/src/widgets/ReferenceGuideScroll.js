// ReferenceGuideScroll — the parchment reference guide, read-only build.
// Two layers:
//   • My guide — the chapters the user has added, collapsible with a colored
//     expansion-source dot, markdown body.
//   • Community pool — browsable list of chapters other players wrote for
//     this game (sorted by popularity), one-tap add to / remove from my
//     guide. Authoring new chapters stays on the web app.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { ScrollText, Plus, Check, ChevronDown, ChevronRight, X, Users } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Row, Text } from '../ui';
import Markdown from '../components/Markdown';
import api from '../api/client';
import { useAppState } from '../store/AppContext';

export default function ReferenceGuideScroll({ gameId, expansionIds = [], defaultOpen = false }) {
  const { chapterTypes, currentUser } = useAppState();
  const [open, setOpen] = useState(defaultOpen);
  const [mine, setMine] = useState(null); // my guide chapters
  const [pool, setPool] = useState(null); // community pool (lazy)
  const [poolOpen, setPoolOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [busyId, setBusyId] = useState(null);

  const expKey = expansionIds.join(',');
  const loadMine = useCallback(async () => {
    try {
      const rows = await api.myChapters(gameId, { expansionIds });
      setMine(rows || []);
    } catch {
      setMine([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, expKey]);

  const loadPool = useCallback(async () => {
    try {
      const rows = await api.chapterPool(gameId, { chapterType: typeFilter || undefined, expansionIds });
      setPool(rows || []);
    } catch {
      setPool([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, typeFilter, expKey]);

  useEffect(() => {
    if (open && mine === null) loadMine();
  }, [open, mine, loadMine]);
  useEffect(() => {
    if (poolOpen) loadPool();
  }, [poolOpen, loadPool]);

  const myIds = new Set((mine || []).map((c) => c.chapter_id || c.id));

  async function addFromPool(ch) {
    setBusyId(ch.id);
    try {
      await api.addChapter(gameId, ch.id);
      await loadMine();
    } catch {}
    setBusyId(null);
  }
  async function removeFromGuide(ch) {
    const chapterId = ch.chapter_id || ch.id;
    setBusyId(chapterId);
    try {
      await api.removeChapter(gameId, chapterId);
      await loadMine();
      if (poolOpen) loadPool();
    } catch {}
    setBusyId(null);
  }

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.header} onPress={() => setOpen((v) => !v)}>
        <ScrollText size={18} color={COLORS.polaroidInk} />
        <Text variant="heading" color={COLORS.polaroidInk} style={{ flex: 1, fontSize: 18 }}>
          Reference guide
        </Text>
        {open ? <ChevronDown size={18} color={COLORS.polaroidInkSoft} /> : <ChevronRight size={18} color={COLORS.polaroidInkSoft} />}
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {mine === null ? (
            <ActivityIndicator color={COLORS.polaroidAccent} style={{ paddingVertical: 16 }} />
          ) : mine.length === 0 ? (
            <Text variant="polaroidItalic" style={{ paddingVertical: SPACING.sm }}>
              No chapters in your guide yet — borrow some from the community below.
            </Text>
          ) : (
            mine.map((ch) => (
              <View key={ch.id} style={styles.chapter}>
                <Row gap="sm">
                  {ch.source_color ? <View style={[styles.dot, { backgroundColor: ch.source_color }]} /> : null}
                  <Pressable
                    style={{ flex: 1, minHeight: 34, justifyContent: 'center' }}
                    onPress={() => setExpanded((e) => ({ ...e, [ch.id]: !e[ch.id] }))}
                  >
                    <Text variant="bodyMedium" color={COLORS.polaroidInk} numberOfLines={1}>
                      {ch.title}
                    </Text>
                  </Pressable>
                  {currentUser ? (
                    <Pressable onPress={() => removeFromGuide(ch)} hitSlop={10} disabled={busyId === (ch.chapter_id || ch.id)}>
                      <X size={15} color={COLORS.polaroidMuted} />
                    </Pressable>
                  ) : null}
                  <Pressable onPress={() => setExpanded((e) => ({ ...e, [ch.id]: !e[ch.id] }))} hitSlop={10}>
                    {expanded[ch.id] ? (
                      <ChevronDown size={16} color={COLORS.polaroidMuted} />
                    ) : (
                      <ChevronRight size={16} color={COLORS.polaroidMuted} />
                    )}
                  </Pressable>
                </Row>
                {expanded[ch.id] ? <Markdown content={ch.content} style={{ marginTop: SPACING.sm }} /> : null}
              </View>
            ))
          )}

          {currentUser ? (
            <Pressable style={styles.poolBtn} onPress={() => setPoolOpen((v) => !v)}>
              <Users size={15} color={COLORS.polaroidAccent} />
              <Text variant="bodyMedium" color={COLORS.polaroidAccent}>
                {poolOpen ? 'Hide community chapters' : 'Browse community chapters'}
              </Text>
            </Pressable>
          ) : null}

          {poolOpen ? (
            <View style={{ marginTop: SPACING.sm }}>
              {chapterTypes.length > 0 ? (
                <Row gap="xs" wrap style={{ marginBottom: SPACING.sm }}>
                  <TypeChip label="All" active={!typeFilter} onPress={() => setTypeFilter(null)} />
                  {chapterTypes.map((t) => (
                    <TypeChip key={t.id} label={t.label} active={typeFilter === t.id} onPress={() => setTypeFilter(t.id)} />
                  ))}
                </Row>
              ) : null}
              {pool === null ? (
                <ActivityIndicator color={COLORS.polaroidAccent} style={{ paddingVertical: 12 }} />
              ) : pool.length === 0 ? (
                <Text variant="polaroidItalic" style={{ paddingVertical: SPACING.sm }}>
                  Nobody has written chapters for this game yet. Be the first — on the web app.
                </Text>
              ) : (
                pool.map((ch) => {
                  const inGuide = myIds.has(ch.id);
                  return (
                    <View key={ch.id} style={styles.chapter}>
                      <Row gap="sm">
                        <Pressable
                          style={{ flex: 1, minHeight: 34, justifyContent: 'center' }}
                          onPress={() => setExpanded((e) => ({ ...e, [`p-${ch.id}`]: !e[`p-${ch.id}`] }))}
                        >
                          <Text variant="bodyMedium" color={COLORS.polaroidInk} numberOfLines={1}>
                            {ch.title}
                          </Text>
                          <Text variant="caption" color={COLORS.polaroidMuted}>
                            {[ch.chapter_type_label || ch.chapter_type, ch.user_count ? `${ch.user_count} guides` : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => (inGuide ? removeFromGuide({ chapter_id: ch.id, id: ch.id }) : addFromPool(ch))}
                          hitSlop={10}
                          disabled={busyId === ch.id}
                          style={[styles.poolAction, inGuide && styles.poolActionOn]}
                        >
                          {busyId === ch.id ? (
                            <ActivityIndicator size="small" color={COLORS.polaroidAccent} />
                          ) : inGuide ? (
                            <Check size={16} color={COLORS.polaroidBg} />
                          ) : (
                            <Plus size={16} color={COLORS.polaroidAccent} />
                          )}
                        </Pressable>
                      </Row>
                      {expanded[`p-${ch.id}`] ? <Markdown content={ch.content} style={{ marginTop: SPACING.sm }} /> : null}
                    </View>
                  );
                })
              )}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TypeChip({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipOn]} hitSlop={4}>
      <Text variant="caption" color={active ? COLORS.polaroidBg : COLORS.polaroidInkSoft}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.polaroidBgSoft,
    borderRadius: RADII.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.polaroidLine,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: SPACING.md, minHeight: 48 },
  body: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.md },
  chapter: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.polaroidLine, paddingVertical: SPACING.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  poolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: SPACING.md,
    paddingVertical: 10,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.polaroidAccent + '88',
    minHeight: 44,
  },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.polaroidLine,
    backgroundColor: COLORS.polaroidBg,
  },
  chipOn: { backgroundColor: COLORS.polaroidAccent, borderColor: COLORS.polaroidAccent },
  poolAction: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.polaroidAccent + '88',
  },
  poolActionOn: { backgroundColor: COLORS.polaroidAccent, borderColor: COLORS.polaroidAccent },
});
