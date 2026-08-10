// CollectionScreen — the shelf. Tabs Owned / Wishlist / Played, search, sort.
// The Owned and Wishlist tabs paint instantly from the offline collection
// store (search included — airplane-mode friendly); the server grid
// reconciles in the background and owns Played, sorting, and pagination.
// route.params: { status, userId } — userId views someone else's shelf
// (server-only, no offline tier).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Search, LibraryBig, Star, History, ArrowUpDown } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Input, RefreshHint, Row, Screen, Text } from '../ui';
import AppHeader from '../components/AppHeader';
import GameTile from '../components/GameTile';
import EmptyState from '../components/EmptyState';
import api from '../api/client';
import { collectionGames } from '../offline/collectionStore';
import { fuzzyScore } from '../domain/gameSearch';

const TABS = [
  { key: 'owned', label: 'Owned', Icon: LibraryBig },
  { key: 'wishlist', label: 'Wishlist', Icon: Star },
  { key: 'played', label: 'Played', Icon: History },
];
const SORTS = [
  { key: 'last_played', label: 'Last played' },
  { key: 'added_at', label: 'Recently added' },
  { key: 'alphabetical', label: 'A–Z' },
];

export default function CollectionScreen({ navigation, route }) {
  const userId = route.params?.userId || undefined;
  const [status, setStatus] = useState(route.params?.status || 'owned');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('last_played');
  const [rows, setRows] = useState(null); // server rows (null = not landed)
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seqRef = useRef(0);

  // Offline tier — instant list for own owned/wishlist while the grid loads.
  const offlineRows = useMemo(() => {
    if (userId || status === 'played') return null;
    let games = collectionGames().filter((g) => g.status === status && !g.is_expansion);
    const q = search.trim();
    if (q) {
      games = games
        .map((g) => ({ g, s: fuzzyScore(q, g.name) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((r) => r.g);
    } else if (sort === 'alphabetical') {
      games = games.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return games.map((g) => ({ game: g, key: g.id }));
  }, [userId, status, search, sort]);

  const load = useCallback(
    async (pageNum) => {
      const seq = ++seqRef.current;
      if (pageNum === 1) setRefreshing(true);
      try {
        const data = await api.collectionGrid({
          status,
          page: pageNum,
          per_page: 24,
          search: search.trim() || undefined,
          sort,
          user_id: userId,
          exclude_expansions: true,
        });
        if (seq !== seqRef.current) return;
        const next = (data.items || []).map((it) => ({ game: it.game || it, key: (it.game || it).id }));
        setTotal(data.total || 0);
        setRows((prev) => (pageNum === 1 ? next : [...(prev || []), ...next]));
        setPage(pageNum);
      } catch {
        if (seq !== seqRef.current) return;
        // Offline: leave rows as-is; the offline tier still renders.
      }
      if (seq === seqRef.current) setRefreshing(false);
    },
    [status, search, sort, userId],
  );

  useEffect(() => {
    setRows(null);
    const t = setTimeout(() => load(1), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  async function loadMore() {
    if (loadingMore || rows === null || rows.length >= total) return;
    setLoadingMore(true);
    await load(page + 1);
    setLoadingMore(false);
  }

  const data = rows ?? offlineRows ?? [];
  const showingOffline = rows === null && offlineRows !== null;
  const tab = TABS.find((t) => t.key === status) || TABS[0];

  return (
    <Screen
      pad={false}
      edges={{ top: false, bottom: false }}
      header={<AppHeader title={userId ? 'Their shelf' : 'My shelf'} onBack={() => navigation.goBack()} />}
    >
      <Row gap="xs" style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => {
              setStatus(t.key);
              setRows(null);
            }}
            style={[styles.tab, status === t.key && styles.tabOn]}
          >
            <t.Icon size={14} color={status === t.key ? COLORS.bg : COLORS.textSoft} />
            <Text variant="bodyMedium" style={{ fontSize: 13 }} color={status === t.key ? COLORS.bg : COLORS.textSoft}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </Row>

      <View style={styles.controls}>
        <Row gap="sm" style={styles.searchRow}>
          <Search size={18} color={COLORS.textMuted} />
          <Input
            placeholder={`Search ${tab.label.toLowerCase()}…`}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            style={{ flex: 1 }}
            inputStyle={styles.bareInput}
          />
        </Row>
        <Row gap="xs" style={{ marginTop: SPACING.sm }}>
          <ArrowUpDown size={13} color={COLORS.textMuted} />
          {SORTS.map((s) => (
            <Pressable key={s.key} onPress={() => setSort(s.key)} style={[styles.sortChip, sort === s.key && styles.sortChipOn]} hitSlop={6}>
              <Text variant="caption" color={sort === s.key ? COLORS.accent : COLORS.textMuted}>
                {s.label}
              </Text>
            </Pressable>
          ))}
        </Row>
      </View>

      <RefreshHint visible={refreshing && data.length > 0} label={showingOffline ? 'Syncing shelf…' : 'Refreshing…'} />

      <FlatList
        data={data}
        keyExtractor={(it) => it.key}
        numColumns={2}
        columnWrapperStyle={styles.col}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.cell}>
            <GameTile
              game={item.game}
              variant="tile"
              showStatus={!userId}
              onPress={() => navigation.navigate('GameDetail', { gameId: item.game.id, gameName: item.game.name })}
            />
          </View>
        )}
        onEndReachedThreshold={0.4}
        onEndReached={loadMore}
        windowSize={7}
        removeClippedSubviews
        ListEmptyComponent={
          refreshing ? null : (
            <EmptyState
              icon={tab.Icon}
              title={status === 'wishlist' ? 'Empty wishlist' : status === 'played' ? 'No plays yet' : 'No games yet'}
              body={
                status === 'wishlist'
                  ? 'Star games you want to play to build your wishlist.'
                  : status === 'played'
                    ? 'Games you log plays for show up here.'
                    : 'Add games to your shelf from any game page.'
              }
            />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    minHeight: 36,
  },
  tabOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  controls: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
  searchRow: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  bareInput: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, minHeight: 40 },
  sortChip: { paddingHorizontal: SPACING.sm, paddingVertical: 5, borderRadius: RADII.pill },
  sortChipOn: { backgroundColor: COLORS.accent + '22' },
  list: { padding: SPACING.lg, paddingTop: SPACING.sm, paddingBottom: 40 },
  col: { gap: SPACING.md, marginBottom: SPACING.md },
  cell: { flex: 1 },
});
