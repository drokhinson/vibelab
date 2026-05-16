// SaucebookScreen — user's recipe library. Mirrors web's saucebook.js.
// Lightweight rows from listSaucebook(), grouped by cuisine, with
// swipe-to-edit / swipe-to-remove and two FABs (meal builder + new recipe).

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import {
  Search,
  X,
  SlidersHorizontal,
  ChevronDown,
  ChevronsUpDown,
  GitBranch,
  ChefHat,
  Plus,
  BookPlus,
  Pencil,
  Trash2,
} from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useAppActions, useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import LoadingPot from '../components/LoadingPot';
import { SAUCE_TYPES } from '#shared/constants';
import { missingSauceIngredients } from '#shared/filter';
import { COLORS, SHADOWS } from '../theme';

export default function SaucebookScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const sb = state.saucebook;

  // Filter rows client-side by search + filter chips. Author filter list is
  // derived from the current saucebook items (matches web).
  const filtered = useMemo(() => {
    const q = (sb.search || '').toLowerCase().trim();
    const { cuisines, types, dishes, authorId } = sb.filters;
    return (sb.items || []).filter((s) => {
      if (q) {
        const hay = `${s.name || ''} ${s.cuisine || ''} ${s.authorName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (cuisines.size > 0 && !cuisines.has(s.cuisine)) return false;
      if (types.size > 0 && !types.has(s.sauceType)) return false;
      if (authorId && s.createdBy !== authorId) return false;
      if (dishes.size > 0) {
        const ids = (s.attachments || []).filter((a) => a.kind === 'dish').map((a) => a.value);
        if (!ids.some((id) => dishes.has(id))) return false;
      }
      return true;
    });
  }, [sb.items, sb.search, sb.filters]);

  // Group by cuisine, then alphabetize within.
  const groups = useMemo(() => {
    const map = new Map();
    for (const s of filtered) {
      const key = s.cuisine || 'Other';
      if (!map.has(key)) map.set(key, { cuisine: key, emoji: s.cuisineEmoji, items: [] });
      map.get(key).items.push(s);
    }
    for (const g of map.values()) g.items.sort((a, b) => a.name.localeCompare(b.name));
    return [...map.values()].sort((a, b) => a.cuisine.localeCompare(b.cuisine));
  }, [filtered]);

  // Collapse-all / expand-all toggle next to the Filters button. Reads the
  // currently-visible cuisine groups and dispatches a bulk flip.
  const anyOpen = useMemo(
    () => groups.some((g) => state.cuisineSections[g.cuisine] !== false),
    [groups, state.cuisineSections],
  );
  const collapseOrExpandAll = useCallback(() => {
    actions.setAllSaucebookCuisines(groups.map((g) => g.cuisine), !anyOpen);
  }, [groups, anyOpen, actions]);

  // Pull-to-refresh — drives the saucebook reload + flips a local "refreshing"
  // True when any saucebook filter is active — drives the visibility of the
  // "Clear all filters" button at the bottom of the filter panel.
  const hasAnyFilter =
    sb.filters.cuisines.size > 0 ||
    sb.filters.types.size > 0 ||
    sb.filters.dishes.size > 0 ||
    !!sb.filters.authorId;

  // flag so the RefreshControl spinner stays up until the fetch resolves.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await actions.loadSaucebook();
    } finally {
      setRefreshing(false);
    }
  }, [actions]);

  // Author list derived from items for the filter panel.
  const authorOptions = useMemo(() => {
    const seen = new Map();
    for (const s of sb.items || []) {
      if (s.createdBy && !seen.has(s.createdBy)) {
        seen.set(s.createdBy, { id: s.createdBy, name: s.authorName || 'Anonymous' });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sb.items]);

  const isAdmin = !!(state.currentUser && state.currentUser.is_admin);
  const currentUserId = state.currentUser?.user_id;

  const [openingId, setOpeningId] = React.useState(null);
  const onRowPress = async (sauce) => {
    if (openingId) return;
    setOpeningId(sauce.id);
    const res = await actions.openSauceById(sauce.id);
    setOpeningId(null);
    if (res.ok) {
      navigation.navigate('Recipe');
    } else {
      // Fallback: still navigate so the user gets feedback; recipe screen
      // will render whatever fields the slim row has.
      actions.selectSauce(sauce);
      navigation.navigate('Recipe');
    }
  };
  const onEdit = (sauce) => navigation.navigate('SauceBuilder', { sauceId: sauce.id });
  const onRemove = (sauce) => actions.removeFromSaucebook(sauce.id);

  if (!state.currentUser) {
    return (
      <View style={styles.screen}>
        <AppHeader title="Saucebook" subtitle="Your recipe library" navigation={navigation} />
        <EmptyState
          title="Sign in to keep recipes"
          body="Your Saucebook is a personal shelf of recipes you've saved from Browse."
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader title="Saucebook" subtitle="Your recipe library" navigation={navigation} />

      <View style={styles.controls}>
        <View style={styles.searchWrap}>
          <Search size={16} color={COLORS.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={sb.search}
            onChangeText={actions.setSaucebookSearch}
            placeholder="Search your library"
            placeholderTextColor={COLORS.textMuted}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {sb.search ? (
            <TouchableOpacity onPress={() => actions.setSaucebookSearch('')} hitSlop={8}>
              <X size={14} color={COLORS.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.filtersBtn, sb.filters.open && styles.filtersBtnActive]}
          onPress={actions.toggleSaucebookFilters}
          activeOpacity={0.8}
        >
          <SlidersHorizontal
            size={14}
            color={sb.filters.open ? '#fff' : COLORS.primary}
          />
          <Text style={[styles.filtersBtnLabel, sb.filters.open && styles.filtersBtnLabelActive]}>
            Filters
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.collapseBtn}
          onPress={collapseOrExpandAll}
          activeOpacity={0.8}
          accessibilityLabel={anyOpen ? 'Collapse all' : 'Expand all'}
        >
          <ChevronsUpDown size={14} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      {sb.filters.open ? (
        <ScrollView
          style={styles.filtersPanel}
          contentContainerStyle={styles.filtersBody}
          keyboardShouldPersistTaps="handled"
        >
          {/* Type first, then Cuisine — matches Browse and gives the longer
              cuisine chip list room to scroll without crowding the panel top.
              Type is horizontal-scrollable so the five chips never wrap to a
              second line on narrow phones. */}
          <Text style={styles.filterGroupLabel}>Type</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.typeScroll}
          >
            {SAUCE_TYPES.map((t) => (
              <Chip
                key={t.value}
                label={t.label}
                active={sb.filters.types.has(t.value)}
                onPress={() => actions.toggleSaucebookType(t.value)}
              />
            ))}
          </ScrollView>

          <Text style={[styles.filterGroupLabel, { marginTop: 14 }]}>Cuisine</Text>
          <View style={styles.chipRow}>
            {(state.refCuisines || []).map((c) => {
              const name = c.cuisine || c.name;
              const active = sb.filters.cuisines.has(name);
              return (
                <Chip
                  key={name}
                  label={`${c.emoji || ''} ${name}`}
                  active={active}
                  onPress={() => actions.toggleSaucebookCuisine(name)}
                />
              );
            })}
          </View>

          {authorOptions.length > 0 ? (
            <>
              <Text style={[styles.filterGroupLabel, { marginTop: 14 }]}>Author</Text>
              <View style={styles.chipRow}>
                {authorOptions.map((a) => (
                  <Chip
                    key={a.id}
                    label={a.name}
                    active={sb.filters.authorId === a.id}
                    onPress={() =>
                      actions.setSaucebookAuthor(sb.filters.authorId === a.id ? null : a.id)
                    }
                  />
                ))}
              </View>
            </>
          ) : null}

          {hasAnyFilter ? (
            <TouchableOpacity
              style={styles.clearAllBtn}
              onPress={actions.clearSaucebookFilters}
              activeOpacity={0.8}
            >
              <Text style={styles.clearAllLabel}>Clear all filters</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      ) : null}

      {sb.loading || !sb.loaded ? (
        <LoadingPot label="Loading your saucebook…" />
      ) : sb.error && sb.items.length === 0 ? (
        <EmptyState
          title="Couldn't load your saucebook"
          body={sb.error}
          action="Try again"
          onAction={actions.loadSaucebook}
        />
      ) : sb.items.length === 0 ? (
        <EmptyState
          title="Your saucebook is empty"
          body="Tap '+ Saucebook' on any recipe in Browse to save it here."
          action="Open Browse"
          onAction={() => navigation.navigate('Home', { screen: 'BrowseTab' })}
        />
      ) : (
        <ScrollView
          style={styles.listBody}
          contentContainerStyle={{ paddingBottom: 120 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={COLORS.primary}
              colors={[COLORS.primary]}
            />
          }
        >
          {groups.length === 0 ? (
            <View style={{ padding: 24, alignItems: 'center' }}>
              <Text style={{ fontSize: 13, color: COLORS.textMuted }}>
                No matches. Try clearing search or filters.
              </Text>
            </View>
          ) : (
            groups.map((g) => {
              const open = state.cuisineSections[g.cuisine] !== false; // default open
              return (
                <View key={g.cuisine} style={styles.group}>
                  <TouchableOpacity
                    style={styles.groupHeader}
                    onPress={() => actions.toggleCuisineSection(g.cuisine)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.groupHeaderText}>
                      {g.emoji ? `${g.emoji} ` : ''}
                      {g.cuisine}{' '}
                      <Text style={styles.groupCount}>({g.items.length})</Text>
                    </Text>
                    <ChevronDown
                      size={16}
                      color={COLORS.textSecondary}
                      style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
                    />
                  </TouchableOpacity>
                  {open
                    ? g.items.map((sauce) => (
                        <SaucebookRow
                          key={sauce.id}
                          sauce={sauce}
                          disabledIngredients={state.disabledIngredients}
                          canEdit={isAdmin || sauce.createdBy === currentUserId}
                          onPress={() => onRowPress(sauce)}
                          onEdit={() => onEdit(sauce)}
                          onRemove={() => onRemove(sauce)}
                        />
                      ))
                    : null}
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* FABs — lower right. Chef hat launches meal builder, plus launches
          the sauce builder modal. */}
      <View style={styles.fabStack} pointerEvents="box-none">
        <TouchableOpacity
          style={[styles.fab, styles.fabSecondary]}
          onPress={() => navigation.navigate('MealBuilder')}
          activeOpacity={0.85}
          accessibilityLabel="Build a meal"
        >
          <ChefHat size={22} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('SauceBuilder')}
          activeOpacity={0.85}
          accessibilityLabel="Import or build a recipe"
        >
          <BookPlus size={22} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Chip({ label, active, onPress }) {
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

function SaucebookRow({ sauce, disabledIngredients, canEdit, onPress, onEdit, onRemove }) {
  const swipeableRef = React.useRef(null);
  const missing = missingSauceIngredients(sauce, disabledIngredients);
  const variantCount = sauce.variantCount || 0;
  // Swipe panels are visual indicators only — onSwipeableOpen fires the
  // action when the user lets go past the threshold, then we close the row.
  // No nested onPress: the user shouldn't have to tap after swiping.
  // Remove panel sits at the right edge of the row (revealed by left-swipe);
  // pin its label to the right so the icon + label hug that edge.
  const renderRightActions = () => (
    <View style={[styles.swipeAction, styles.swipeRemove, styles.swipeActionRight]}>
      <Trash2 size={16} color="#fff" />
      <Text style={styles.swipeActionLabel}>Remove</Text>
    </View>
  );

  // Edit panel sits at the left edge (revealed by right-swipe); pin label
  // to the left for symmetric hugging.
  const renderLeftActions = () =>
    canEdit ? (
      <View style={[styles.swipeAction, styles.swipeEdit, styles.swipeActionLeft]}>
        <Pencil size={16} color="#fff" />
        <Text style={styles.swipeActionLabel}>Edit</Text>
      </View>
    ) : null;

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      renderLeftActions={canEdit ? renderLeftActions : undefined}
      overshootRight={false}
      overshootLeft={false}
      friction={1.5}
      rightThreshold={60}
      leftThreshold={60}
      onSwipeableOpen={(direction) => {
        // direction === 'right' → right actions revealed (left swipe) → Remove
        // direction === 'left'  → left actions revealed (right swipe) → Edit
        swipeableRef.current?.close();
        if (direction === 'right') onRemove();
        else if (direction === 'left' && canEdit) onEdit();
      }}
    >
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
        <View style={[styles.rowSwatch, { backgroundColor: sauce.color || COLORS.primary }]} />
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowName} numberOfLines={1}>
              {sauce.name}
            </Text>
            {variantCount > 0 ? (
              <View style={styles.variantBadge}>
                <GitBranch size={10} color={COLORS.textSecondary} />
                <Text style={styles.variantBadgeLabel}>{variantCount + 1} versions</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {sauce.authorName ? sauce.authorName : ''}
            {sauce.sauceType ? (sauce.authorName ? ' · ' : '') + capitalize(sauce.sauceType) : ''}
          </Text>
          {missing.length > 0 ? (
            <Text style={styles.missingBadge}>Missing {missing.length}</Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
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
  searchInput: { flex: 1, fontSize: 13, color: COLORS.text },
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
  filtersBtnActive: { backgroundColor: COLORS.primary },
  filtersBtnLabel: { fontSize: 12, fontWeight: '700', color: COLORS.primary },
  filtersBtnLabelActive: { color: '#fff' },
  collapseBtn: {
    height: 34,
    width: 34,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Filter panel takes about half the screen now so cuisine chips + future
  // search dropdowns have room to render without crowding the row list.
  filtersPanel: {
    maxHeight: 480,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
  },
  filtersBody: { padding: 12, paddingBottom: 48 },
  filterGroupLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 8,
    marginBottom: 4,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  typeScroll: { flexDirection: 'row', gap: 6, paddingRight: 12 },
  clearAllBtn: {
    marginTop: 16,
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
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipLabel: { fontSize: 12, fontWeight: '700', color: COLORS.textSecondary },
  chipLabelActive: { color: '#fff' },
  listBody: { flex: 1, paddingHorizontal: 12, paddingTop: 8 },
  group: { marginBottom: 8 },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  groupHeaderText: {
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.text,
  },
  groupCount: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 6,
    ...SHADOWS.sm,
  },
  rowSwatch: { width: 14, height: 14, borderRadius: 7 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  missingBadge: {
    marginTop: 4,
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.dangerText,
    backgroundColor: COLORS.danger,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  swipeAction: {
    width: 90,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  // Per-side alignment: Edit pin to the left edge of its panel, Remove pin
  // to the right edge — keeps the label closer to whichever screen edge
  // the user swiped from.
  swipeActionLeft: {
    justifyContent: 'flex-start',
  },
  swipeActionRight: {
    justifyContent: 'flex-end',
  },
  swipeRemove: { backgroundColor: COLORS.dangerText },
  swipeEdit: { backgroundColor: COLORS.primary },
  swipeActionLabel: { color: '#fff', fontWeight: '800', fontSize: 12 },
  fabStack: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    alignItems: 'flex-end',
    gap: 12,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.lg,
  },
  fabSecondary: {
    backgroundColor: COLORS.primaryDark,
  },
});
