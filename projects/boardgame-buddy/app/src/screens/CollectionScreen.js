// CollectionScreen — owned or wishlist grid. route.params.status selects which
// ('owned' | 'wishlist'); optional userId targets another user. Mirrors
// web/views/collection-view.js + wishlist-view.js (one screen, status param).

import React, { useState, useEffect, useCallback } from 'react';
import { View, TextInput, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, LibraryBig, Star } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import api from '../api/client';

export default function CollectionScreen({ navigation, route }) {
  const status = route.params?.status || 'owned';
  const userId = route.params?.userId || undefined;
  const [items, setItems] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const title = status === 'wishlist' ? 'Wishlist' : 'Collection';

  const load = useCallback(
    async (pageNum, searchTerm) => {
      const data = await api.collectionGrid({
        status,
        page: pageNum,
        per_page: 24,
        search: searchTerm || undefined,
        user_id: userId,
        exclude_expansions: true,
      });
      const next = data.items || [];
      setTotal(data.total || 0);
      setItems((prev) => (pageNum === 1 ? next : [...(prev || []), ...next]));
    },
    [status, userId],
  );

  useEffect(() => {
    setItems(null);
    setPage(1);
    load(1, search).catch(() => setItems([]));
  }, [status, userId]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => {
      setItems(null);
      setPage(1);
      load(1, search).catch(() => setItems([]));
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  async function loadMore() {
    if (loadingMore || !items || items.length >= total) return;
    setLoadingMore(true);
    const next = page + 1;
    try {
      await load(next, search);
      setPage(next);
    } catch {}
    setLoadingMore(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title={title} onBack={() => navigation.goBack()} />
      <View style={styles.searchRow}>
        <Search size={18} color={COLORS.textMuted} />
        <TextInput
          style={styles.input}
          placeholder={`Search ${title.toLowerCase()}…`}
          placeholderTextColor={COLORS.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
        />
      </View>
      {items === null ? (
        <LoadingState label={`Loading ${title.toLowerCase()}…`} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it, i) => it.game_id || it.game?.id || String(i)}
          numColumns={2}
          columnWrapperStyle={styles.col}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const game = item.game || item;
            return (
              <View style={styles.cell}>
                <GameTile
                  game={game}
                  variant="tile"
                  showStatus={!userId}
                  onPress={() => navigation.navigate('GameDetail', { gameId: game.id, gameName: game.name })}
                />
              </View>
            );
          }}
          onEndReachedThreshold={0.4}
          onEndReached={loadMore}
          ListEmptyComponent={
            <EmptyState
              icon={status === 'wishlist' ? Star : LibraryBig}
              title={status === 'wishlist' ? 'Empty wishlist' : 'No games yet'}
              body={status === 'wishlist' ? 'Star games you want to play to build your wishlist.' : 'Add games to your shelf from any game page.'}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, backgroundColor: COLORS.card, borderRadius: RADII.md, paddingHorizontal: SPACING.md, marginHorizontal: SPACING.lg, marginVertical: SPACING.sm, borderWidth: 1, borderColor: COLORS.border },
  input: { flex: 1, color: COLORS.text, fontFamily: FONTS.sans, fontSize: 15, paddingVertical: 10 },
  list: { padding: SPACING.lg, paddingTop: SPACING.sm },
  col: { gap: SPACING.md, marginBottom: SPACING.md },
  cell: { flex: 1 },
});
