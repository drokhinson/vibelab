import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ThumbsUp } from 'lucide-react-native';
import { useAppActions, useAppState, getCachedYesterday } from '../store/AppContext';
import { formatDate } from '#shared/format';
import GroupSwitcher from '../components/GroupSwitcher';
import WordDisplay from '../components/WordDisplay';
import HighlightedSentence from '../components/HighlightedSentence';
import LoadingState from '../components/LoadingState';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function VoteScreen() {
  const state = useAppState();
  const { activeGroupId, yesterdayLoading } = state;
  const { loadYesterday, castVote } = useAppActions();
  const yesterdayData = getCachedYesterday(state, activeGroupId);
  const [voting, setVoting] = useState(null);

  useEffect(() => {
    if (!activeGroupId) return;
    loadYesterday(activeGroupId).catch(() => {});
  }, [activeGroupId, loadYesterday]);

  const sentences = useMemo(() => {
    const list = yesterdayData?.sentences || [];
    if (yesterdayData?.has_voted) return list;
    // Shuffle pre-vote so authorship is harder to guess.
    return [...list].sort(() => Math.random() - 0.5);
  }, [yesterdayData]);

  const maxVotes = useMemo(() => {
    return (yesterdayData?.sentences || []).reduce((m, s) => Math.max(m, s.vote_count || 0), 0);
  }, [yesterdayData]);

  if (!activeGroupId) {
    return <View style={styles.empty}><Text style={styles.emptyText}>Join a group to start voting.</Text></View>;
  }

  if (!yesterdayData) {
    return (
      <View style={{ flex: 1 }}>
        <GroupSwitcher />
        <LoadingState label={yesterdayLoading ? 'Loading yesterday’s sentences…' : ''} />
      </View>
    );
  }

  const { word, has_voted, date } = yesterdayData;

  if (!word || sentences.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        <GroupSwitcher />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No sentences to vote on yet — check back after everyone submits for today!
          </Text>
        </View>
      </View>
    );
  }

  const handleVote = async (sentenceId) => {
    setVoting(sentenceId);
    try {
      await castVote(activeGroupId, sentenceId);
    } catch {
      // ignore, optimistic UI rollback could be added
    } finally {
      setVoting(null);
    }
  };

  return (
    <FlatList
      data={sentences}
      keyExtractor={(item) => String(item.id)}
      ListHeaderComponent={(
        <>
          <GroupSwitcher />
          <WordDisplay word={word} />
          <Text style={styles.dateHint}>
            {formatDate(date)} — {has_voted ? 'you’ve voted! results below' : 'vote for the best sentence'}
          </Text>
        </>
      )}
      renderItem={({ item: s }) => (
        <SentenceCard
          item={s}
          word={word.word}
          maxVotes={maxVotes}
          hasVoted={has_voted}
          voting={voting === s.id}
          onVote={() => handleVote(s.id)}
        />
      )}
      contentContainerStyle={{ paddingBottom: SPACING.xxl, paddingHorizontal: SPACING.lg }}
    />
  );
}

function SentenceCard({ item, word, maxVotes, hasVoted, voting, onVote }) {
  const isWinner = hasVoted && item.vote_count === maxVotes && maxVotes > 0;
  const cardStyle = [
    styles.card,
    item.i_voted && styles.cardVoted,
    isWinner && styles.cardWinner,
  ];

  const author = hasVoted
    ? `${item.display_name || 'Player'}${item.is_mine ? ' (you)' : ''}`
    : (item.is_mine ? 'Your sentence' : '');

  return (
    <View style={cardStyle}>
      {isWinner ? <Text style={styles.winnerBadge}>🏆 Top pick</Text> : null}
      <HighlightedSentence
        sentence={`"${item.sentence}"`}
        word={word}
        style={styles.sentenceText}
      />
      <View style={styles.footer}>
        <Text style={styles.author}>{author}</Text>
        <Pressable
          onPress={onVote}
          disabled={item.is_mine || hasVoted || voting}
          style={[
            styles.voteBtn,
            (item.i_voted || isWinner) && styles.voteBtnVoted,
            (item.is_mine || hasVoted) && styles.voteBtnDisabled,
          ]}
        >
          <ThumbsUp size={16} color={item.i_voted ? '#fff' : COLORS.textSecondary} />
          {hasVoted ? <Text style={[styles.voteCount, item.i_voted && { color: '#fff' }]}>{item.vote_count}</Text> : null}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, padding: SPACING.xl, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: COLORS.textSecondary, fontSize: FONT_SIZES.body, textAlign: 'center', lineHeight: 22 },
  dateHint: { color: COLORS.textMuted, fontSize: FONT_SIZES.small, textAlign: 'center', marginVertical: SPACING.md, paddingHorizontal: SPACING.lg },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADII.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardVoted: { borderColor: COLORS.primary, borderWidth: 2 },
  cardWinner: { borderColor: COLORS.gold, borderWidth: 2 },
  winnerBadge: { color: COLORS.gold, fontSize: FONT_SIZES.small, fontWeight: '700', marginBottom: SPACING.xs },
  sentenceText: { color: COLORS.text, fontSize: FONT_SIZES.card, lineHeight: 24, marginBottom: SPACING.sm, fontStyle: 'italic' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACING.sm },
  author: { color: COLORS.textMuted, fontSize: FONT_SIZES.small },
  voteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.surfaceSubtle,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADII.pill,
  },
  voteBtnVoted: { backgroundColor: COLORS.primary },
  voteBtnDisabled: { opacity: 0.6 },
  voteCount: { color: COLORS.textSecondary, fontWeight: '700', fontSize: FONT_SIZES.small },
});
