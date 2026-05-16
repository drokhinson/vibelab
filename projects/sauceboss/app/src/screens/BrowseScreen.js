// BrowseScreen — paginated public-discovery list. Mirrors web's browse.js.
// Filters (cuisine / type / dish / author) compound; any filter change
// resets `page` to 0 via the reducer. Tap a row to open Recipe; tap
// "+ Saucebook" to add (optimistic).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import {
  Search,
  X,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Plus,
  Check,
} from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import LoadingPot from '../components/LoadingPot';
import SauceRow from '../components/SauceRow';
import { BASE_API_URL } from '../api/client';
import { SAUCE_TYPES } from '#shared/constants';
import { COLORS, SHADOWS } from '../theme';

export default function BrowseScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const b = state.browse;
  const listRef = useRef(null);

  // Debounce search input — wait 300ms after the user stops typing
  // before refetching. Matches web's browseRunSearch debounce.
  const searchDebounce = useRef(null);
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      actions.loadBrowseSauces();
    }, 300);
    return () => searchDebounce.current && clearTimeout(searchDebounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.q]);

  // Reload whenever any non-search filter changes or the page advances.
  // Cuisines/types/dishes are Sets so we serialize them for the dep array.
  const filterKey = useMemo(
    () =>
      `${b.page}|${[...b.cuisines].sort().join(',')}|${[...b.types].sort().join(',')}|${[...b.dishes].sort().join(',')}|${b.authorId || ''}`,
    [b.page, b.cuisines, b.types, b.dishes, b.authorId],
  );
  useEffect(() => {
    actions.loadBrowseSauces();
    // Scroll to top on filter / page change.
    listRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // Build the dish filter pool from initial-load lists (flat parent dishes).
  const dishPool = useMemo(() => {
    const merge = (arr, category) =>
      (arr || []).map((d) => ({ id: d.id, name: d.name, emoji: d.emoji, category }));
    return [
      ...merge(state.carbs, 'carb'),
      ...merge(state.proteins, 'protein'),
      ...merge(state.saladBases, 'salad'),
    ];
  }, [state.carbs, state.proteins, state.saladBases]);

  const hasAnyFilter =
    b.q || b.cuisines.size > 0 || b.types.size > 0 || b.dishes.size > 0 || b.authorId;
  const fromIdx = b.total === 0 ? 0 : b.page * b.pageSize + 1;
  const toIdx = Math.min(b.total, (b.page + 1) * b.pageSize);
  const lastPage = Math.max(0, Math.ceil(b.total / b.pageSize) - 1);
  const isSignedIn = !!state.currentUser;

  const [openingId, setOpeningId] = React.useState(null);
  const [cuisineQ, setCuisineQ] = React.useState('');
  const [dishQ, setDishQ] = React.useState('');
  // Pull-to-refresh — fires loadBrowseSauces; the existing useEffect on
  // filterKey also covers re-fetching when filters change, but the manual
  // pull keeps the gesture available for force-refresh on stale data.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await actions.loadBrowseSauces();
    } finally {
      setRefreshing(false);
    }
  }, [actions]);
  const onRowPress = async (sauce) => {
    if (openingId) return;
    setOpeningId(sauce.id);
    const res = await actions.openSauceById(sauce.id);
    setOpeningId(null);
    if (res.ok) {
      navigation.navigate('Recipe');
    } else {
      // Fall back to the slim row so the recipe screen at least mounts;
      // the user will see empty steps but no dead navigation.
      actions.selectSauce(sauce);
      navigation.navigate('Recipe');
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader title="Browse" subtitle="Discover recipes" navigation={navigation} />

      <View style={styles.controls}>
        <View style={styles.searchWrap}>
          <Search size={16} color={COLORS.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={b.q}
            onChangeText={actions.setBrowseSearch}
            placeholder="Search recipes"
            placeholderTextColor={COLORS.textMuted}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {b.q ? (
            <TouchableOpacity onPress={() => actions.setBrowseSearch('')} hitSlop={8}>
              <X size={14} color={COLORS.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.filtersBtn, b.filtersOpen && styles.filtersBtnActive]}
          onPress={actions.toggleBrowseFilters}
          activeOpacity={0.8}
        >
          <SlidersHorizontal size={14} color={b.filtersOpen ? '#fff' : COLORS.primary} />
          <Text
            style={[styles.filtersBtnLabel, b.filtersOpen && styles.filtersBtnLabelActive]}
          >
            Filters
          </Text>
        </TouchableOpacity>
      </View>

      {b.filtersOpen ? (
        <ScrollView
          style={styles.filtersPanel}
          contentContainerStyle={styles.filtersBody}
          keyboardShouldPersistTaps="handled"
        >
          {/* Type — chip row, no search (short fixed list) */}
          <Text style={styles.filterGroupLabel}>Type</Text>
          <View style={styles.chipRow}>
            {SAUCE_TYPES.map((t) => {
              const active = b.types.has(t.value);
              return (
                <FilterChip
                  key={t.value}
                  label={t.label}
                  active={active}
                  onPress={() => actions.toggleBrowseType(t.value)}
                />
              );
            })}
          </View>

          {/* Cuisine — search → suggest dropdown → selected chips below.
              Mirrors web's renderFilterChips cuisine block: long catalog,
              so we don't display every cuisine pill by default. */}
          <Text style={[styles.filterGroupLabel, { marginTop: 12 }]}>Cuisine</Text>
          <FilterSearchInput
            value={cuisineQ}
            onChangeText={setCuisineQ}
            placeholder="Search cuisines"
          />
          {(() => {
            const q = cuisineQ.trim().toLowerCase();
            if (!q) return null;
            const matches = (state.refCuisines || []).filter((c) => {
              const name = c.cuisine || c.name || '';
              if (b.cuisines.has(name)) return false;
              return name.toLowerCase().includes(q);
            });
            if (matches.length === 0) return null;
            return (
              <View style={styles.suggestDropdown}>
                {matches.map((c) => {
                  const name = c.cuisine || c.name;
                  return (
                    <TouchableOpacity
                      key={name}
                      onPress={() => {
                        actions.toggleBrowseCuisine(name);
                        setCuisineQ('');
                      }}
                      style={styles.suggestItem}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.suggestItemLabel}>
                        {c.emoji ? `${c.emoji} ` : ''}{name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            );
          })()}
          {b.cuisines.size > 0 ? (
            <View style={[styles.chipRow, { marginTop: 6 }]}>
              {[...b.cuisines].map((name) => {
                const c = (state.refCuisines || []).find((x) => (x.cuisine || x.name) === name);
                return (
                  <FilterChip
                    key={name}
                    label={`${c?.emoji || ''} ${name} ✕`}
                    active
                    onPress={() => actions.toggleBrowseCuisine(name)}
                  />
                );
              })}
            </View>
          ) : null}

          {/* Pairs with — same search-and-select pattern as Cuisine */}
          {dishPool.length > 0 ? (
            <>
              <Text style={[styles.filterGroupLabel, { marginTop: 12 }]}>Pairs with</Text>
              <FilterSearchInput
                value={dishQ}
                onChangeText={setDishQ}
                placeholder="Search dishes"
              />
              {(() => {
                const q = dishQ.trim().toLowerCase();
                if (!q) return null;
                const matches = dishPool.filter((d) => {
                  if (b.dishes.has(d.id)) return false;
                  return (d.name || '').toLowerCase().includes(q);
                });
                if (matches.length === 0) return null;
                return (
                  <View style={styles.suggestDropdown}>
                    {matches.map((d) => (
                      <TouchableOpacity
                        key={d.id}
                        onPress={() => {
                          actions.toggleBrowseDish(d.id);
                          setDishQ('');
                        }}
                        style={styles.suggestItem}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.suggestItemLabel}>
                          {d.emoji ? `${d.emoji} ` : ''}{d.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                );
              })()}
              {b.dishes.size > 0 ? (
                <View style={[styles.chipRow, { marginTop: 6 }]}>
                  {[...b.dishes].map((id) => {
                    const d = dishPool.find((x) => x.id === id);
                    if (!d) return null;
                    return (
                      <FilterChip
                        key={id}
                        label={`${d.emoji || ''} ${d.name} ✕`}
                        active
                        onPress={() => actions.toggleBrowseDish(id)}
                      />
                    );
                  })}
                </View>
              ) : null}
            </>
          ) : null}

          {/* Author — single-select. Search fires fetchBrowseAuthors;
              suggest dropdown picks; selected author shown as a chip. */}
          <Text style={[styles.filterGroupLabel, { marginTop: 12 }]}>Author</Text>
          {b.authorId && b.authorQuery ? (
            <View style={styles.chipRow}>
              <FilterChip
                label={`${b.authorQuery} ✕`}
                active
                onPress={() => actions.setBrowseAuthor(null, '')}
              />
            </View>
          ) : (
            <>
              <FilterSearchInput
                value={b.authorQuery || ''}
                onChangeText={(v) => {
                  actions.setBrowseAuthorQuery(v);
                  if (v.trim().length >= 2) actions.fetchBrowseAuthors(v);
                }}
                placeholder="Search authors"
              />
              {(b.authorResults || []).length > 0 && (b.authorQuery || '').trim().length >= 2 ? (
                <View style={styles.suggestDropdown}>
                  {b.authorResults.map((a) => (
                    <TouchableOpacity
                      key={a.userId || a.id || a.displayName}
                      onPress={() =>
                        actions.setBrowseAuthor(a.userId || a.id || null, a.displayName || '')
                      }
                      style={styles.suggestItem}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.suggestItemLabel}>{a.displayName}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
            </>
          )}

          {hasAnyFilter ? (
            <TouchableOpacity
              style={styles.clearAllBtn}
              onPress={actions.clearBrowseFilters}
              activeOpacity={0.8}
            >
              <Text style={styles.clearAllLabel}>Clear all filters</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      ) : null}

      {b.loading && b.items.length === 0 ? (
        <LoadingPot label="Loading recipes…" />
      ) : b.error && b.items.length === 0 ? (
        <EmptyState
          title="Couldn't load recipes"
          body={`${b.error}\n\nAPI: ${BASE_API_URL}`}
          action="Try again"
          onAction={actions.loadBrowseSauces}
        />
      ) : b.items.length === 0 ? (
        <EmptyState
          title={hasAnyFilter ? 'No matches' : 'Nothing here yet'}
          body={hasAnyFilter ? 'Try clearing some filters.' : 'Check back soon.'}
          action={hasAnyFilter ? 'Clear filters' : null}
          onAction={hasAnyFilter ? actions.clearBrowseFilters : null}
        />
      ) : (
        <FlatList
          ref={listRef}
          data={b.items}
          keyExtractor={(s) => s.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.primary}
              colors={[COLORS.primary]}
            />
          }
          renderItem={({ item }) => (
            <BrowseRow
              sauce={item}
              isSignedIn={isSignedIn}
              opening={openingId === item.id}
              onPress={() => onRowPress(item)}
              onAdd={() => actions.addToSaucebook(item)}
              onRemove={() => actions.removeFromSaucebook(item.id)}
            />
          )}
          contentContainerStyle={styles.listBody}
          ListFooterComponent={
            b.total > b.pageSize ? (
              <View style={styles.pagination}>
                <TouchableOpacity
                  style={[styles.pageBtn, b.page === 0 && styles.pageBtnDisabled]}
                  onPress={() => actions.goBrowsePage(b.page - 1)}
                  disabled={b.page === 0}
                  activeOpacity={0.7}
                >
                  <ChevronLeft size={16} color={b.page === 0 ? COLORS.textMuted : COLORS.primary} />
                </TouchableOpacity>
                <Text style={styles.pageIndicator}>
                  {fromIdx}–{toIdx} of {b.total}
                </Text>
                <TouchableOpacity
                  style={[styles.pageBtn, b.page >= lastPage && styles.pageBtnDisabled]}
                  onPress={() => actions.goBrowsePage(b.page + 1)}
                  disabled={b.page >= lastPage}
                  activeOpacity={0.7}
                >
                  <ChevronRight
                    size={16}
                    color={b.page >= lastPage ? COLORS.textMuted : COLORS.primary}
                  />
                </TouchableOpacity>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

function FilterChip({ label, active, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      activeOpacity={0.8}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function FilterSearchInput({ value, onChangeText, placeholder }) {
  return (
    <View style={styles.filterSearchWrap}>
      <Search size={14} color={COLORS.textMuted} />
      <TextInput
        style={styles.filterSearchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMuted}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {value ? (
        <TouchableOpacity onPress={() => onChangeText('')} hitSlop={8}>
          <X size={12} color={COLORS.textMuted} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function BrowseRow({ sauce, isSignedIn, opening, onPress, onAdd, onRemove }) {
  const variantCount = sauce.variantCount ? sauce.variantCount + 1 : 1;
  const subline =
    `${sauce.cuisineEmoji ? `${sauce.cuisineEmoji} ` : ''}${sauce.cuisine || ''}${sauce.authorName ? ` · ${sauce.authorName}` : ''}` || null;

  const rightSlot = opening ? (
    <ActivityIndicator size="small" color={COLORS.primary} />
  ) : isSignedIn ? (
    // Toggle: tap when in saucebook → remove; tap when out → add. Stays
    // enabled so the inner Touchable captures the tap rather than letting
    // it bubble up to the row's onPress (which navigates).
    <TouchableOpacity
      onPress={sauce.inSaucebook ? onRemove : onAdd}
      style={[styles.addBtn, sauce.inSaucebook && styles.addBtnAdded]}
      activeOpacity={0.8}
      hitSlop={6}
      accessibilityLabel={sauce.inSaucebook ? 'Remove from saucebook' : 'Add to saucebook'}
    >
      {sauce.inSaucebook ? (
        <Check size={14} color={COLORS.successText} />
      ) : (
        <Plus size={14} color={COLORS.primary} />
      )}
    </TouchableOpacity>
  ) : null;

  return (
    <SauceRow
      sauce={sauce}
      subline={subline}
      variantCount={variantCount}
      rightSlot={rightSlot}
      onPress={onPress}
      disabled={opening}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    height: 36,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
  },
  filtersBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  filtersBtnActive: {
    backgroundColor: COLORS.primary,
  },
  filtersBtnLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
  },
  filtersBtnLabelActive: {
    color: '#fff',
  },
  // Tall enough that the cuisine/dish/author suggest dropdowns can render
  // their full match list inside the panel without getting clipped.
  filtersPanel: {
    maxHeight: 520,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  filtersBody: {
    padding: 12,
    paddingBottom: 48,
  },
  filterGroupLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 8,
    marginBottom: 4,
  },
  filterSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
  },
  filterSearchInput: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    padding: 0,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  chipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  chipLabelActive: {
    color: '#fff',
  },
  suggestDropdown: {
    marginTop: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 2,
    borderTopColor: COLORS.primary,
    backgroundColor: COLORS.card,
    overflow: 'hidden',
  },
  suggestItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  suggestItemLabel: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
  },
  clearAllBtn: {
    marginTop: 14,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.dangerText,
  },
  clearAllLabel: {
    color: COLORS.dangerText,
    fontSize: 12,
    fontWeight: '700',
  },
  listBody: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    ...SHADOWS.sm,
  },
  rowSwatch: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowName: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    flexShrink: 1,
  },
  rowMeta: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  variantBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: COLORS.surfaceSubtle,
  },
  variantBadgeLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  addBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  addBtnAdded: {
    backgroundColor: COLORS.success,
    borderColor: COLORS.successText,
  },
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingVertical: 12,
  },
  pageBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  pageBtnDisabled: {
    opacity: 0.4,
    borderColor: COLORS.border,
  },
  pageIndicator: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
});
