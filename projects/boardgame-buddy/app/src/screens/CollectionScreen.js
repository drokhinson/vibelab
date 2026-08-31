// CollectionScreen — owned or wishlist grid. route.params.status selects which
// ('owned' | 'wishlist'); optional userId targets another user. Mirrors
// web/views/collection-view.js + wishlist-view.js (one screen, status param).

import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LibraryBig, Star } from 'lucide-react-native';
import { COLORS, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import LoadingState from '../components/LoadingState';
import EmptyState from '../components/EmptyState';
import SearchField from '../components/SearchField';
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
        // Alphabetical, matching the web spokes (web/domain/shelf-filter.js).
        // The endpoint defaults to last_played DESC NULLS LAST.
        sort: 'alphabetical',
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
      <SearchField
        style={styles.searchRow}
        value={search}
        onChangeText={setSearch}
        placeholder={`Search ${title.toLowerCase()}…`}
        clearLabel={`Clear ${title.toLowerCase()} search`}
      />
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
  searchRow: { marginHorizontal: SPACING.lg, marginVertical: SPACING.sm },
  list: { padding: SPACING.lg, paddingTop: SPACING.sm },
  col: { gap: SPACING.md, marginBottom: SPACING.md },
  cell: { flex: 1 },
});
