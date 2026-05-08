import React, { useEffect } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useAppActions, useAppState, getCachedLeaderboard } from '../store/AppContext';
import GroupSwitcher from '../components/GroupSwitcher';
import LoadingState from '../components/LoadingState';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function LeaderboardScreen() {
  const state = useAppState();
  const { activeGroupId, leaderboardLoading, currentUser } = state;
  const { loadLeaderboard } = useAppActions();
  const data = getCachedLeaderboard(state, activeGroupId);

  useEffect(() => {
    if (!activeGroupId) return;
    loadLeaderboard(activeGroupId).catch(() => {});
  }, [activeGroupId, loadLeaderboard]);

  if (!activeGroupId) {
    return <View style={styles.empty}><Text style={styles.emptyText}>Join a group to see the leaderboard.</Text></View>;
  }

  if (!data) {
    return (
      <View style={{ flex: 1 }}>
        <GroupSwitcher />
        <LoadingState label={leaderboardLoading ? 'Loading leaderboard…' : ''} />
      </View>
    );
  }

  const { group_name, group_code, leaderboard = [] } = data;

  return (
    <FlatList
      data={leaderboard}
      keyExtractor={(item) => String(item.user_id)}
      ListHeaderComponent={(
        <>
          <GroupSwitcher />
          <View style={styles.headerCard}>
            <Text style={styles.groupName}>{group_name}</Text>
            <Text style={styles.groupCode}>code · <Text style={styles.codeBadge}>{group_code}</Text></Text>
          </View>
        </>
      )}
      ListEmptyComponent={(
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No submissions yet — be the first to write a sentence!</Text>
        </View>
      )}
      renderItem={({ item }) => {
        const isMe = item.user_id === currentUser?.id;
        const rankEmoji = item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : `#${item.rank}`;
        return (
          <View style={[styles.row, isMe && styles.rowMe]}>
            <Text style={styles.rank}>{rankEmoji}</Text>
            <Text style={styles.name} numberOfLines={1}>
              {item.display_name || 'Player'}
              {isMe ? <Text style={styles.you}> (you)</Text> : null}
            </Text>
            <Text style={styles.votes}>{item.total_votes} votes</Text>
          </View>
        );
      }}
      contentContainerStyle={{ paddingBottom: SPACING.xxl, paddingHorizontal: SPACING.lg }}
    />
  );
}

const styles = StyleSheet.create({
  empty: { padding: SPACING.xl, alignItems: 'center' },
  emptyText: { color: COLORS.textSecondary, textAlign: 'center', lineHeight: 22 },
  headerCard: { paddingVertical: SPACING.lg, alignItems: 'center' },
  groupName: { fontSize: FONT_SIZES.title, fontWeight: '800', color: COLORS.text },
  groupCode: { color: COLORS.textMuted, marginTop: SPACING.xs },
  codeBadge: { fontFamily: 'monospace', color: COLORS.primary, fontWeight: '700', letterSpacing: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: SPACING.md,
    borderRadius: RADII.md,
    marginBottom: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.md,
  },
  rowMe: { borderColor: COLORS.primary },
  rank: { width: 36, fontWeight: '700', color: COLORS.text },
  name: { flex: 1, color: COLORS.text, fontWeight: '600', fontSize: FONT_SIZES.body },
  you: { color: COLORS.primary, fontSize: FONT_SIZES.caption },
  votes: { color: COLORS.textSecondary, fontWeight: '600', fontSize: FONT_SIZES.body },
});
