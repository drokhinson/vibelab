import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import HighlightedSentence from '../components/HighlightedSentence';
import LoadingState from '../components/LoadingState';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function DictionaryScreen({ navigation }) {
  const { allWords, playedWords, allWordsLoaded, playedWordsLoaded, currentUser } = useAppState();
  const { loadAllWords, loadPlayedWords } = useAppActions();
  const [filter, setFilter] = useState('played');

  useEffect(() => {
    if (filter === 'played' && !playedWordsLoaded) loadPlayedWords().catch(() => {});
    if (filter === 'all' && !allWordsLoaded) loadAllWords().catch(() => {});
  }, [filter, playedWordsLoaded, allWordsLoaded, loadAllWords, loadPlayedWords]);

  const list = filter === 'played' ? playedWords : allWords;
  const isLoaded = filter === 'played' ? playedWordsLoaded : allWordsLoaded;

  const sections = useMemo(() => {
    const groups = {};
    for (const w of list) {
      const letter = (w.word || '?')[0]?.toUpperCase() || '?';
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(w);
    }
    return Object.keys(groups).sort().map((letter) => ({ title: letter, data: groups[letter] }));
  }, [list]);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View style={styles.filterRow}>
          <Pressable
            style={[styles.filterBtn, filter === 'played' && styles.filterBtnActive]}
            onPress={() => setFilter('played')}
          >
            <Text style={[styles.filterText, filter === 'played' && styles.filterTextActive]}>Played</Text>
          </Pressable>
          <Pressable
            style={[styles.filterBtn, filter === 'all' && styles.filterBtnActive]}
            onPress={() => setFilter('all')}
          >
            <Text style={[styles.filterText, filter === 'all' && styles.filterTextActive]}>All Words</Text>
          </Pressable>
        </View>
        <Pressable style={styles.proposeBtn} onPress={() => navigation.navigate('ProposeWord')}>
          <Text style={styles.proposeBtnText}>+ Propose</Text>
        </Pressable>
      </View>

      {!isLoaded ? <LoadingState /> : list.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {filter === 'played' ? 'No played words yet — submit a sentence to see them here.' : 'No words in the dictionary yet.'}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.id)}
          renderSectionHeader={({ section: { title } }) => (
            <Text style={styles.letterHeader}>{title}</Text>
          )}
          renderItem={({ item }) => <DictCard word={item} currentUser={currentUser} />}
          contentContainerStyle={{ paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xxl }}
          stickySectionHeadersEnabled
        />
      )}
    </View>
  );
}

function DictCard({ word, currentUser }) {
  const isMyWin = word.winning_user_id && currentUser && word.winning_user_id === currentUser.id;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.word}>{word.word}</Text>
        <Text style={styles.pos}>{word.part_of_speech}</Text>
      </View>
      <Text style={styles.def}>{word.definition}</Text>
      {word.etymology ? (
        <Text style={styles.etym}><Text style={{ fontWeight: '700' }}>Origin: </Text>{word.etymology}</Text>
      ) : null}
      {word.is_played && word.my_sentence && !isMyWin ? (
        <View style={styles.mineBlock}>
          <Text style={styles.mineLabel}>✍️ Your sentence</Text>
          <HighlightedSentence
            sentence={`"${word.my_sentence}"`}
            word={word.word}
            style={styles.mineText}
          />
        </View>
      ) : null}
      {word.winning_sentence ? (
        <View style={[styles.winnerBlock, isMyWin && styles.winnerMine]}>
          <Text style={styles.winnerLabel}>{isMyWin ? '👑 Your winning sentence' : '🏆 Best sentence'}</Text>
          <HighlightedSentence
            sentence={`"${word.winning_sentence}"`}
            word={word.word}
            style={styles.winnerText}
          />
          {!isMyWin && word.winning_author ? (
            <Text style={styles.winnerAuthor}>— {word.winning_author}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', padding: SPACING.lg, gap: SPACING.sm },
  filterRow: { flexDirection: 'row', flex: 1, backgroundColor: COLORS.surfaceSubtle, borderRadius: RADII.md, padding: 2 },
  filterBtn: { flex: 1, paddingVertical: SPACING.sm, alignItems: 'center', borderRadius: RADII.md },
  filterBtnActive: { backgroundColor: COLORS.surface },
  filterText: { color: COLORS.textSecondary, fontWeight: '600', fontSize: FONT_SIZES.small },
  filterTextActive: { color: COLORS.primary },
  proposeBtn: { backgroundColor: COLORS.primary, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADII.pill },
  proposeBtnText: { color: '#fff', fontWeight: '700', fontSize: FONT_SIZES.small },
  empty: { padding: SPACING.xl, alignItems: 'center' },
  emptyText: { color: COLORS.textSecondary, textAlign: 'center', lineHeight: 22 },
  letterHeader: {
    backgroundColor: COLORS.background,
    fontSize: FONT_SIZES.body,
    fontWeight: '800',
    color: COLORS.primary,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADII.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING.sm, marginBottom: SPACING.xs },
  word: { fontSize: 18, fontWeight: '800', color: COLORS.text },
  pos: { fontStyle: 'italic', color: COLORS.textMuted, fontSize: FONT_SIZES.small },
  def: { color: COLORS.textSecondary, fontSize: FONT_SIZES.body, lineHeight: 22 },
  etym: { color: COLORS.textMuted, fontSize: FONT_SIZES.small, marginTop: SPACING.sm, lineHeight: 18 },
  mineBlock: { backgroundColor: COLORS.surfaceSubtle, padding: SPACING.sm, borderRadius: RADII.sm, marginTop: SPACING.sm },
  mineLabel: { fontSize: FONT_SIZES.caption, fontWeight: '700', color: COLORS.textMuted, marginBottom: 2 },
  mineText: { color: COLORS.text, fontStyle: 'italic', fontSize: FONT_SIZES.small, lineHeight: 18 },
  winnerBlock: { backgroundColor: COLORS.warning, padding: SPACING.sm, borderRadius: RADII.sm, marginTop: SPACING.sm },
  winnerMine: { backgroundColor: COLORS.success },
  winnerLabel: { fontSize: FONT_SIZES.caption, fontWeight: '700', color: COLORS.warningText, marginBottom: 2 },
  winnerText: { color: COLORS.text, fontStyle: 'italic', fontSize: FONT_SIZES.small, lineHeight: 18 },
  winnerAuthor: { color: COLORS.textMuted, fontSize: FONT_SIZES.caption, marginTop: 2 },
});
