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
  Download,
  GitBranch,
  GitMerge,
  Heart,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAppActions, useAppState } from '../../store/AppContext';
import { api } from '../../api/client';
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
  const editMode = !!state.editMode;
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

  // Admin-only bulk export. Mirrors per-sauce exportSauce: fetch the body,
  // write to cache, hand the URI to the platform share sheet.
  async function handleBulkExport() {
    try {
      const text = await api.exportAllSaucesJson();
      const today = new Date().toISOString().slice(0, 10);
      const filename = `sauceboss-sauces-${today}.json`;
      const uri = FileSystem.cacheDirectory + filename;
      await FileSystem.writeAsStringAsync(uri, text, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support the share sheet.');
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'application/json',
        dialogTitle: 'Export all SauceBoss recipes',
        UTI: 'public.json',
      });
    } catch (e) {
      Alert.alert('Export failed', e?.message || 'Could not download catalog.');
    }
  }

  function pickExportFormat(sauce) {
    Alert.alert(
      `Export "${sauce.name}"`,
      'Choose a format. Markdown is human-readable; JSON is the round-trip format you can re-import in the builder.',
      [
        { text: 'JSON', onPress: () => exportSauce(sauce, 'json') },
        { text: 'Markdown', onPress: () => exportSauce(sauce, 'md') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  function toggleCuisine(cuisine) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    actions.toggleManagerCuisine(cuisine);
  }

  async function commitMerge() {
    const res = await actions.commitSauceMerge();
    if (!res.ok && res.error) Alert.alert('Could not merge', res.error);
  }

  const merge = state.sauceMerge;
  const isMerging = !!merge;
  const keepSauce = isMerging
    ? (state.managerSauces || []).find((s) => s.id === merge.keepId)
    : null;

  return (
    <>
      {isMerging ? (
        <View style={styles.mergePanel}>
          <Text style={styles.mergePanelTitle}>
            Variant family parent: <Text style={{ fontWeight: '900' }}>{keepSauce?.name || '?'}</Text>
          </Text>
          <Text style={styles.mergePanelHelp}>
            Tap other sauces to mark them as variants of this one. They'll appear as a single
            family in the sauce list, with this recipe as the default version.
          </Text>
        </View>
      ) : null}

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
                        editMode={editMode}
                        showTypeTag={typeFilter === 'all'}
                        merge={merge}
                        onTap={() => {
                          if (isMerging) actions.toggleSauceMergePick(displayed.id);
                          else openSauceRecipe(displayed, family);
                        }}
                        onLongPress={() => {
                          // Variant rows already belong to a family — long-press
                          // is reserved for root rows so we don't accidentally
                          // re-parent a variant.
                          const isRoot = !displayed.parentSauceId;
                          if (isAdmin && !isMerging && isRoot) {
                            actions.startSauceMerge(displayed.id);
                          }
                        }}
                        onEdit={() => openBuilderFor(displayed.id)}
                        onDelete={() => confirmDelete(displayed)}
                        onDownload={() => pickExportFormat(displayed)}
                        onStartMerge={() => actions.startSauceMerge(displayed.id)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
        {isAdmin && editMode && !isMerging ? (
          <TouchableOpacity
            style={styles.bulkExportBtn}
            onPress={handleBulkExport}
            activeOpacity={0.85}
          >
            <Download size={14} color={COLORS.primary} />
            <Text style={styles.bulkExportLabel}>Export all sauces (JSON)</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      {isMerging ? (
        <View style={[styles.mergeBar, { paddingBottom: Math.max(12, fabBottom - 32) }]}>
          <Text style={styles.mergeBarText}>
            {merge.mergeIds.size === 0
              ? 'Tap rows to mark as variants'
              : `${merge.mergeIds.size} to assign as variant${merge.mergeIds.size === 1 ? '' : 's'} of ${keepSauce?.name || '?'}`}
          </Text>
          <View style={styles.mergeBarActions}>
            <TouchableOpacity
              style={styles.mergeCancelBtn}
              onPress={() => actions.cancelSauceMerge()}
              activeOpacity={0.7}
            >
              <Text style={styles.mergeCancelLabel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.mergeCommitBtn,
                (merge.mergeIds.size === 0 || merge.saving) && styles.mergeCommitDisabled,
              ]}
              onPress={commitMerge}
              disabled={merge.mergeIds.size === 0 || merge.saving}
              activeOpacity={0.8}
            >
              <Text style={styles.mergeCommitLabel}>{merge.saving ? 'Merging…' : 'Merge'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : isLoggedIn && editMode ? (
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

function slugifySauceName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'sauce';
}

// Fetch a sauce export, write it to the cache directory, then hand the URI to
// the platform share sheet. Cache files are auto-purged by the OS so we don't
// need to clean up. Both export endpoints are public; the API client still
// passes the JWT when one is set.
async function exportSauce(sauce, format /* 'json' | 'md' */) {
  try {
    const text = format === 'json'
      ? await api.exportSauceJson(sauce.id)
      : await api.exportSauceMd(sauce.id);

    const filename = `${slugifySauceName(sauce.name || sauce.id)}.sauce.${format}`;
    const uri = FileSystem.cacheDirectory + filename;
    await FileSystem.writeAsStringAsync(uri, text, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert('Sharing unavailable', 'This device does not support the share sheet.');
      return;
    }
    await Sharing.shareAsync(uri, {
      mimeType: format === 'json' ? 'application/json' : 'text/markdown',
      dialogTitle: `Export ${sauce.name}`,
      UTI: format === 'json' ? 'public.json' : 'net.daringfireball.markdown',
    });
  } catch (e) {
    Alert.alert('Export failed', e?.message || 'Could not download recipe.');
  }
}

function ManagerSauceRow({
  sauce,
  family,
  isLast,
  currentUser,
  isAdmin,
  editMode,
  showTypeTag,
  merge,
  onTap,
  onLongPress,
  onEdit,
  onDelete,
  onDownload,
  onStartMerge,
}) {
  const isOwner = !!(currentUser && sauce.createdBy === currentUser.user_id);
  // Edit mode (header pencil toggle) gates all editorial affordances. Mirrors
  // the web's state.editMode behavior so the read-only browse view is the
  // default for logged-in users; flipping the toggle reveals the full row of
  // Edit / Download / Delete / Merge actions and the `+` FAB.
  const canEdit = editMode && (isAdmin || isOwner);
  const canDelete = editMode && (isAdmin || isOwner);
  const variants = (family?.variants || []).length;
  const totalVersions = 1 + variants;
  const isVariantRow = !!sauce.parentSauceId;

  const isMerging = !!merge;
  const isKeep = merge?.keepId === sauce.id;
  const isPicked = merge?.mergeIds?.has(sauce.id);

  const containerStyle = [
    styles.row,
    !isLast && styles.rowBorder,
    isKeep && styles.rowKeep,
    isPicked && styles.rowPicked,
  ];

  return (
    <View style={containerStyle}>
      <TouchableOpacity
        style={styles.rowMain}
        onPress={onTap}
        onLongPress={onLongPress}
        delayLongPress={350}
        activeOpacity={0.7}
      >
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
        {isMerging ? (
          isKeep ? (
            <View style={[styles.mergeTag, styles.mergeTagKeep]}>
              <Text style={styles.mergeTagLabel}>parent</Text>
            </View>
          ) : isPicked ? (
            <View style={[styles.mergeTag, styles.mergeTagPicked]}>
              <Text style={styles.mergeTagLabel}>will be variant</Text>
            </View>
          ) : null
        ) : (
          <>
            {showTypeTag ? <SauceTypeTag value={sauce.sauceType || 'sauce'} /> : null}
            {currentUser ? <HeartButton sauceId={sauce.id} size={20} /> : null}
            <ChevronRight size={16} color={COLORS.textMuted} />
          </>
        )}
      </TouchableOpacity>

      {!isMerging && editMode && (canEdit || canDelete || (isAdmin && !isVariantRow)) ? (
        <View style={styles.rowActions}>
          {canEdit ? (
            <TouchableOpacity onPress={onEdit} style={styles.actionBtn} hitSlop={6}>
              <Pencil size={14} color={COLORS.primary} />
              <Text style={styles.actionLabel}>Edit</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={onDownload} style={styles.actionBtn} hitSlop={6}>
            <Download size={14} color={COLORS.textSecondary} />
            <Text style={[styles.actionLabel, { color: COLORS.textSecondary }]}>Download</Text>
          </TouchableOpacity>
          {canDelete ? (
            <TouchableOpacity onPress={onDelete} style={styles.actionBtn} hitSlop={6}>
              <Trash2 size={14} color={COLORS.dangerText} />
              <Text style={[styles.actionLabel, { color: COLORS.dangerText }]}>Delete</Text>
            </TouchableOpacity>
          ) : null}
          {isAdmin && !isVariantRow ? (
            <TouchableOpacity onPress={onStartMerge} style={styles.actionBtn} hitSlop={6}>
              <GitMerge size={14} color={COLORS.textSecondary} />
              <Text style={[styles.actionLabel, { color: COLORS.textSecondary }]}>Merge</Text>
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
    gap: 8,
  },
  bulkExportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'center',
    marginTop: 24,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: 'rgba(232, 93, 4, 0.06)',
  },
  bulkExportLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 4,
    marginRight: 2,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
    marginLeft: 3,
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

  // Merge mode (admin sauce-variant assignment) — orange callout up top,
  // sticky action bar at the bottom that replaces the FAB while active.
  mergePanel: {
    backgroundColor: COLORS.warning,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.warningText,
  },
  mergePanelTitle: { fontSize: 13, fontWeight: '800', color: COLORS.warningText },
  mergePanelHelp: { fontSize: 11, color: COLORS.warningText, marginTop: 2 },
  rowKeep: { backgroundColor: '#FFF3E0' },
  rowPicked: { backgroundColor: '#FEF9C3' },
  mergeTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginLeft: 6 },
  mergeTagKeep: { backgroundColor: COLORS.primary },
  mergeTagPicked: { backgroundColor: '#FBBF24' },
  mergeTagLabel: { fontSize: 10, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },
  mergeBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  mergeBarText: { flex: 1, fontSize: 12, fontWeight: '700', color: COLORS.text },
  mergeBarActions: { flexDirection: 'row', gap: 8 },
  mergeCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  mergeCancelLabel: { fontSize: 13, fontWeight: '700', color: COLORS.textSecondary },
  mergeCommitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: COLORS.primary,
  },
  mergeCommitDisabled: { opacity: 0.5 },
  mergeCommitLabel: { fontSize: 13, fontWeight: '800', color: '#fff' },
});
