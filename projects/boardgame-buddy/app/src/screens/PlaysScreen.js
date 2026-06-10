// PlaysScreen — chronological plays log. Each row → PlayDetailPopup (the same
// "open a play" destination as PlayCard's maximize). Mirrors web/views/plays-view.js.

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { History } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import PlayDetailPopup from '../widgets/PlayDetailPopup';
import api from '../api/client';

export default function PlaysScreen({ navigation, route }) {
  const userId = route.params?.userId || undefined;
  const [plays, setPlays] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (pageNum) => {
      const data = await api.plays({ page: pageNum, per_page: 20, user_id: userId });
      const next = data.plays || [];
      setTotal(data.total || 0);
      setPlays((prev) => (pageNum === 1 ? next : [...(prev || []), ...next]));
    },
    [userId],
  );

  useEffect(() => {
    load(1).catch(() => setPlays([]));
  }, [load]);

  async function loadMore() {
    if (loadingMore || !plays || plays.length >= total) return;
    setLoadingMore(true);
    const next = page + 1;
    try {
      await load(next);
      setPage(next);
    } catch {}
    setLoadingMore(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Plays" onBack={() => navigation.goBack()} />
      {plays === null ? (
        <LoadingState label="Loading plays…" />
      ) : (
        <FlatList
          data={plays}
          keyExtractor={(p) => p.id || p.play_id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <PlayRow play={item} />}
          onEndReachedThreshold={0.4}
          onEndReached={loadMore}
          ListEmptyComponent={<EmptyState icon={History} title="No plays logged" body="Plays you record show up here." />}
        />
      )}
    </SafeAreaView>
  );
}

function PlayRow({ play }) {
  const g = play.game || { name: play.game_name, id: play.game_id, thumbnail_url: play.game_thumbnail_url };
  const winners = (play.players || []).filter((p) => p.is_winner).map((p) => p.name);
  return (
    <Pressable style={styles.row} onPress={() => PlayDetailPopup.show(play.id || play.play_id)}>
      <GameTile game={g} variant="thumb" showStatus={false} onPress={() => PlayDetailPopup.show(play.id || play.play_id)} />
      <View style={styles.rowMeta}>
        <Text style={styles.date}>{play.played_at}</Text>
        {winners.length ? <Text style={styles.winner} numberOfLines={1}>🏆 {winners.join(', ')}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  list: { padding: SPACING.lg, gap: SPACING.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, backgroundColor: COLORS.card, borderRadius: RADII.md, padding: SPACING.sm, borderWidth: 1, borderColor: COLORS.borderSoft },
  rowMeta: { alignItems: 'flex-end' },
  date: { fontFamily: FONTS.score, color: COLORS.textMuted, fontSize: 11 },
  winner: { fontFamily: FONTS.sansMedium, color: COLORS.textSoft, fontSize: 12, marginTop: 2, maxWidth: 120 },
});
