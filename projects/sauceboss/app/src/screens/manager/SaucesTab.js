// Sauces tab body for the Sauce Manager. Extracted from SauceManagerScreen so
// we can mount it side-by-side with the new Dish + Ingredients tabs without
// pushing a single file past 1000 lines.

import React, { useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  LayoutAnimation,
} from 'react-native';
import {
  ChevronRight,
  GitBranch,
  Heart,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react-native';
import { useAppActions, useAppState } from '../../store/AppContext';
import { buildSauceFamilies, pickDisplayedFromFamily, familyHasFavorite } from '#shared/families';
import { SAUCE_TYPES } from '#shared/constants';
import HeartButton from '../../components/HeartButton';
import LoadingPot from '../../components/LoadingPot';
import EmptyState from '../../components/EmptyState';
import { COLORS, SHADOWS } from '../../theme';

const TYPE_FILTERS = [
  { value: 'all', label: 'All' },
  ...SAUCE_TYPES.map((t) => ({ value: t.value, label: t.label })),
];

export default function SauceManagerSaucesTab({ navigation, scrollPaddingBottom, fabBottom }) {
  const state = useAppState();
  const actions = useAppActions();

  useEffect(() => {
    actions.loadAllSauces();
    const unsub = navigation.addListener('focus', () => {
      actions.loadAllSauces();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAdmin = !!state.currentUser?.is_admin;
  const isLoggedIn = !!state.currentUser;
  const search = (state.managerSearch || '').toLowerCase().trim();
  const typeFilter = state.managerTypeFilter || 'all';
  const favOnly = state.managerFavoritesOnly && isLoggedIn;

  const visibleEntries = useMemo(() => {
    const filtered = (state.managerSauces || []).filter((s) => {
      if (typeFilter !== 'all' && (s.sauceType || 'sauce') !== typeFilter) return false;
      if (search) {
        const haystack = `${s.name || ''} ${s.cuisine || ''} ${(s.ingredients || [])
          .map((i) => i.name)
          .join(' ')}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    const families = buildSauceFamilies(filtered);
    let famsArr = [...families.values()];
    if (favOnly) {
      famsArr = famsArr.filter((f) => familyHasFavorite(f, state.favorites, state.currentUser));
    }
    return famsArr.map((family) => ({
      family,
      displayed: pickDisplayedFromFamily(family, state.favorites, state.currentUser),
    }));
  }, [state.managerSauces, search, typeFilter, favOnly, state.favorites, state.currentUser]);

  const cuisines = useMemo(
    () => [...new Set(visibleEntries.map((e) => e.displayed.cuisine || 'Other'))].sort(),
    [visibleEntries],
  );

  function openSauceRecipe(sauce, family) {
    actions.selectSauce(sauce, [family.root, ...family.variants]);
    navigation.navigate('Recipe');
  }

  function openBuilderFor(sauceId) {
    navigation.navigate('SauceBuilder', sauceId ? { sauceId } : undefined);
  }

  function confirmDelete(sauce) {
    Alert.alert(
      `Delete "${sauce.name}"?`,
      'This removes the recipe permanently. Variants of this sauce stay in the catalog but lose their parent link.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const res = await actions.deleteSauce(sauce.id);
            if (!res.ok) Alert.alert('Could not delete', res.error || 'Unknown error');
          },
        },
      ],
    );
  }

  function toggleCuisine(cuisine) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    actions.toggleManagerCuisine(cuisine);
  }

  return (
    <>
      <View style={styles.typeFilterWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.typeRow}>
          {TYPE_FILTERS.map((t) => {
            const active = typeFilter === t.value;
            return (
              <TouchableOpacity
                key={t.value}
                onPress={() => actions.setManagerTypeFilter(t.value)}
                style={[styles.typePill, active && styles.typePillActive]}
                activeOpacity={0.8}
              >
                <Text style={[styles.typePillLabel, active && styles.typePillLabelActive]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
          {isLoggedIn ? (
            <TouchableOpacity
              onPress={() => actions.setManagerFavoritesOnly(!favOnly)}
              style={[styles.typePill, favOnly && styles.typePillActive]}
              activeOpacity={0.8}
            >
              <Heart
                size={13}
                color={favOnly ? '#fff' : COLORS.primary}
                fill={favOnly ? '#fff' : 'transparent'}
                strokeWidth={2}
              />
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollBody, { paddingBottom: scrollPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {state.managerLoading && state.managerSauces.length === 0 ? (
          <LoadingPot label="Loading sauces…" />
        ) : state.managerError ? (
          <EmptyState
            title="Couldn't load sauces"
            body={state.managerError}
            action="Try again"
            onAction={() => actions.loadAllSauces()}
          />
        ) : cuisines.length === 0 ? (
          <EmptyState
            title="No matches"
            body={
              search || typeFilter !== 'all' || favOnly
                ? 'Try clearing filters or search.'
                : 'No sauces yet. Tap the + button to add one.'
            }
          />
        ) : (
          cuisines.map((cuisine) => {
            const entries = visibleEntries.filter(
              (e) => (e.displayed.cuisine || 'Other') === cuisine,
            );
            const isOpen = state.managerExpandedCuisines.has(cuisine);
            const cuisineEmoji = entries[0]?.displayed.cuisineEmoji || '🍽️';
            return (
              <View key={cuisine} style={styles.cuisineGroup}>
                <TouchableOpacity
                  style={styles.cuisineHeader}
                  onPress={() => toggleCuisine(cuisine)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.cuisineFlag}>{cuisineEmoji}</Text>
                  <Text style={styles.cuisineName}>{cuisine}</Text>
                  <Text style={styles.cuisineCount}>{entries.length}</Text>
                  <Text style={[styles.chev, isOpen && styles.chevOpen]}>▾</Text>
                </TouchableOpacity>
                {isOpen ? (
                  <View style={styles.rows}>
                    {entries.map(({ family, displayed }, i) => (
                      <ManagerSauceRow
                        key={displayed.id}
                        sauce={displayed}
                        family={family}
                        isLast={i === entries.length - 1}
                        currentUser={state.currentUser}
                        isAdmin={isAdmin}
                        showTypeTag={typeFilter === 'all'}
                        onTap={() => openSauceRecipe(displayed, family)}
                        onEdit={() => openBuilderFor(displayed.id)}
                        onDelete={() => confirmDelete(displayed)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      {isLoggedIn ? (
        <TouchableOpacity
          style={[styles.fab, { bottom: fabBottom }]}
          onPress={() => openBuilderFor(null)}
          activeOpacity={0.8}
        >
          <Plus size={26} color="#fff" />
        </TouchableOpacity>
      ) : null}
    </>
  );
}

function ManagerSauceRow({
  sauce,
  family,
  isLast,
  currentUser,
  isAdmin,
  showTypeTag,
  onTap,
  onEdit,
  onDelete,
}) {
  const isOwner = !!(currentUser && sauce.createdBy === currentUser.user_id);
  const canEdit = isAdmin || isOwner;
  const canDelete = isAdmin || isOwner;
  const variants = (family?.variants || []).length;
  const totalVersions = 1 + variants;

  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <TouchableOpacity style={styles.rowMain} onPress={onTap} activeOpacity={0.7}>
        <View style={[styles.dot, { backgroundColor: sauce.color || COLORS.primary }]} />
        <View style={styles.rowInfo}>
          <View style={styles.rowNameRow}>
            <Text style={styles.rowName} numberOfLines={1}>{sauce.name}</Text>
            {totalVersions > 1 ? (
              <View style={styles.variantBadge}>
                <GitBranch size={10} color={COLORS.textSecondary} />
                <Text style={styles.variantBadgeText}>{totalVersions}</Text>
              </View>
            ) : null}
          </View>
          {sauce.description ? (
            <Text style={styles.rowDesc} numberOfLines={1}>{sauce.description}</Text>
          ) : null}
        </View>
        {showTypeTag ? <SauceTypeTag value={sauce.sauceType || 'sauce'} /> : null}
        {currentUser ? <HeartButton sauceId={sauce.id} size={20} /> : null}
        <ChevronRight size={16} color={COLORS.textMuted} />
      </TouchableOpacity>
      {canEdit || canDelete ? (
        <View style={styles.rowActions}>
          {canEdit ? (
            <TouchableOpacity onPress={onEdit} style={styles.actionBtn} hitSlop={6}>
              <Pencil size={14} color={COLORS.primary} />
              <Text style={styles.actionLabel}>Edit</Text>
            </TouchableOpacity>
          ) : null}
          {canDelete ? (
            <TouchableOpacity onPress={onDelete} style={styles.actionBtn} hitSlop={6}>
              <Trash2 size={14} color={COLORS.dangerText} />
              <Text style={[styles.actionLabel, { color: COLORS.dangerText }]}>Delete</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function SauceTypeTag({ value }) {
  const meta = SAUCE_TYPES.find((t) => t.value === value) || SAUCE_TYPES[0];
  const tint =
    value === 'marinade' ? '#FBBF24'
    : value === 'dressing' ? '#86EFAC'
    : '#FCD34D';
  return (
    <View style={[styles.typeTag, { backgroundColor: tint }]}>
      <Text style={styles.typeTagLabel}>{meta.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  typeFilterWrap: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  typeRow: {
    paddingVertical: 4,
    paddingRight: 8,
    gap: 6,
  },
  typePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.card,
    marginRight: 6,
  },
  typePillActive: {
    backgroundColor: COLORS.primaryDark,
  },
  typePillLabel: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  typePillLabelActive: {
    color: '#fff',
  },
  scrollBody: {
    padding: 16,
  },
  cuisineGroup: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  cuisineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  cuisineFlag: { fontSize: 20, marginRight: 10 },
  cuisineName: { flex: 1, fontSize: 15, fontWeight: '700', color: COLORS.text },
  cuisineCount: { fontSize: 12, color: COLORS.textMuted, marginRight: 8 },
  chev: { fontSize: 14, color: COLORS.textMuted },
  chevOpen: { transform: [{ rotate: '180deg' }] },
  rows: { borderTopWidth: 1, borderTopColor: COLORS.surfaceSubtle },
  row: { paddingHorizontal: 14, paddingVertical: 10 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#F9FAFB' },
  rowMain: { flexDirection: 'row', alignItems: 'center' },
  rowInfo: { flex: 1, marginLeft: 10, marginRight: 8 },
  rowNameRow: { flexDirection: 'row', alignItems: 'center' },
  rowName: { fontSize: 14, fontWeight: '700', color: COLORS.text, flexShrink: 1 },
  rowDesc: { fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  variantBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceSubtle,
  },
  variantBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textSecondary,
    marginLeft: 2,
  },
  typeTag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
  },
  typeTagLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#1A1A2E',
    letterSpacing: 0.3,
  },
  rowActions: {
    flexDirection: 'row',
    marginTop: 6,
    paddingLeft: 20,
    gap: 14,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginRight: 6,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
    marginLeft: 4,
  },
  fab: {
    position: 'absolute',
    right: 18,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.lg,
  },
});
