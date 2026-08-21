// PlaysScreen — chronological play history (own + shared), searchable, with a
// game/buddy filter sheet (entry stays out of the dense list — D6). Rows open
// PlayDetailPopup, the same affordance as everywhere else. Server pages via
// useCachedResource per (search, filter, page-1) key; pagination appends.

import React, { useMemo, useRef, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, View } from 'react-native';
import { Search, SlidersHorizontal, Star, History } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Input, RefreshHint, Row, Screen, Sheet, Skeleton, Text } from '../ui';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import PlayDetailPopup from '../widgets/PlayDetailPopup';
import api from '../api/client';
import { useAppState } from '../store/AppContext';
import { useCachedResource } from '../store/cache';

export default function PlaysScreen({ navigation, route }) {
  const userId = route.params?.userId || undefined;
  const { playPartners } = useAppState();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [gameFilter, setGameFilter] = useState(null); // {value,label}
  const [buddyFilter, setBuddyFilter] = useState(null);
  const [extra, setExtra] = useState([]); // appended pages
  const [loadingMore, setLoadingMore] = useState(false);
  const sheetRef = useRef(null);
  const debounceTimer = useRef(null);

  function onSearch(v) {
    setSearch(v);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setExtra([]);
      setDebounced(v.trim());
    }, 300);
  }

  const filterKey = `${debounced}|${gameFilter?.value || ''}|${buddyFilter?.value || ''}|${userId || ''}`;
  const { data: firstPage, loading, refreshing } = useCachedResource(`plays:${filterKey}`, () =>
    api.plays({
      page: 1,
      per_page: 20,
      search: debounced || undefined,
      game_id: gameFilter?.value,
      buddy_id: buddyFilter?.value,
      user_id: userId,
    }),
  );
  // Filter options, assembled client-side. The backend's /plays/filter-options
  // is gone, but /plays still takes game_id + buddy_id, and both option sets
  // are already available: recently-played is the games you've actually
  // logged or been in, and playPartners.recent (GET /played-with) is exactly
  // "accounts who appear in plays you're part of".
  const { data: recentGames } = useCachedResource(
    userId ? null : 'plays:filter-games',
    () => api.recentlyPlayedGames({ limit: 30 }),
  );
  const filterOptions = useMemo(
    () => ({
      games: (recentGames || []).map((g) => ({ value: g.id, label: g.name })),
      buddies: (playPartners.recent || []).map((u) => ({
        value: u.user_id || u.id,
        label: u.display_name,
      })),
    }),
    [recentGames, playPartners.recent],
  );

  const plays = useMemo(() => [...(firstPage?.plays || []), ...extra], [firstPage, extra]);
  const total = firstPage?.total || 0;

  async function loadMore() {
    if (loadingMore || !firstPage || plays.length >= total) return;
    setLoadingMore(true);
    try {
      const page = Math.floor(plays.length / 20) + 1;
      const next = await api.plays({
        page,
        per_page: 20,
        search: debounced || undefined,
        game_id: gameFilter?.value,
        buddy_id: buddyFilter?.value,
        user_id: userId,
      });
      setExtra((prev) => [...prev, ...(next.plays || [])]);
    } catch {}
    setLoadingMore(false);
  }

  const hasFilter = !!(gameFilter || buddyFilter);

  return (
    <Screen
      pad={false}
      edges={{ top: false, bottom: false }}
      header={<AppHeader title={userId ? 'Their plays' : 'Play history'} onBack={() => navigation.goBack()} />}
    >
      <View style={styles.controls}>
        <Row gap="sm">
          <Row gap="sm" style={styles.searchRow}>
            <Search size={18} color={COLORS.textMuted} />
            <Input
              placeholder="Game or player…"
              value={search}
              onChangeText={onSearch}
              autoCorrect={false}
              style={{ flex: 1 }}
              inputStyle={styles.bareInput}
            />
          </Row>
          {!userId ? (
            <Pressable style={[styles.filterBtn, hasFilter && styles.filterBtnOn]} onPress={() => sheetRef.current?.present()} hitSlop={6}>
              <SlidersHorizontal size={18} color={hasFilter ? COLORS.bg : COLORS.textSoft} />
            </Pressable>
          ) : null}
        </Row>
        {hasFilter ? (
          <Row gap="xs" style={{ marginTop: SPACING.sm }}>
            {[gameFilter, buddyFilter].filter(Boolean).map((f) => (
              <Pressable
                key={f.value}
                onPress={() => {
                  setExtra([]);
                  if (f === gameFilter) setGameFilter(null);
                  else setBuddyFilter(null);
                }}
                style={styles.activeFilter}
              >
                <Text variant="caption" color={COLORS.accent}>
                  {f.label} ✕
                </Text>
              </Pressable>
            ))}
          </Row>
        ) : null}
      </View>

      <RefreshHint visible={refreshing && plays.length > 0} />

      {loading ? (
        <View style={{ padding: SPACING.lg, gap: SPACING.sm }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={64} radius={12} />
          ))}
        </View>
      ) : (
        <FlatList
          data={plays}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <PlayRow play={item} onPress={() => PlayDetailPopup.show(item.id)} />}
          onEndReachedThreshold={0.4}
          onEndReached={loadMore}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyState icon={History} title="No plays found" body={debounced || hasFilter ? 'Try a different search or filter.' : 'Log your first game from the Play tab.'} />
          }
        />
      )}

      <Sheet ref={sheetRef} title="Filter plays" snap="70%">
        <FilterGroup label="By game" options={filterOptions?.games || []} active={gameFilter} onPick={(f) => { setExtra([]); setGameFilter(f); sheetRef.current?.dismiss(); }} />
        <FilterGroup label="By buddy" options={filterOptions?.buddies || []} active={buddyFilter} onPick={(f) => { setExtra([]); setBuddyFilter(f); sheetRef.current?.dismiss(); }} />
      </Sheet>
    </Screen>
  );
}

// The play-history row: thumb + game + date + winner. Tap = detail popup.
function PlayRow({ play, onPress }) {
  const winner = (play.players || []).find((p) => p.is_winner);
  return (
    <Pressable style={styles.playRow} onPress={onPress}>
      {play.game_thumbnail ? (
        <Image source={{ uri: play.game_thumbnail }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, { backgroundColor: COLORS.cardSoft }]} />
      )}
      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium" numberOfLines={1}>
          {play.game_name}
        </Text>
        <Text variant="caption">
          {[play.played_at, `${(play.players || []).length} players`, !play.is_own ? `by ${play.logged_by_name}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {winner ? (
        <Row gap={3}>
          <Star size={12} color={COLORS.accent} fill={COLORS.accent} />
          <Text variant="caption" color={COLORS.textSoft} numberOfLines={1} style={{ maxWidth: 90 }}>
            {winner.name}
          </Text>
        </Row>
      ) : null}
    </Pressable>
  );
}

function FilterGroup({ label, options, active, onPick }) {
  if (!options.length) return null;
  return (
    <View style={{ marginBottom: SPACING.lg }}>
      <Text variant="label" style={{ marginBottom: SPACING.sm }}>
        {label}
      </Text>
      <Row gap="xs" wrap>
        {options.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => onPick(active?.value === o.value ? null : { value: o.value, label: o.label })}
            style={[styles.optChip, active?.value === o.value && styles.optChipOn]}
          >
            <Text variant="small" color={active?.value === o.value ? COLORS.bg : COLORS.textSoft}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm },
  searchRow: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  bareInput: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, minHeight: 40 },
  filterBtn: {
    width: 44,
    height: 44,
    borderRadius: RADII.md,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  activeFilter: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.accent + '22',
  },
  list: { padding: SPACING.lg, paddingTop: SPACING.sm, paddingBottom: 40, gap: SPACING.xs },
  playRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 64,
  },
  thumb: { width: 48, height: 48, borderRadius: RADII.sm },
  optChip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 7,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    minHeight: 34,
  },
  optChipOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
});
