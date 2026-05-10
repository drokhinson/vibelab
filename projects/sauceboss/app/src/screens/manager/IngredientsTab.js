// Ingredients tab — every ingredient in the catalog grouped by category,
// with usage counts. Anyone can browse + read. Logged-in users can add new
// ingredients (the backend's POST /admin/ingredients is open to all auth'd users).
// Admins can rename, delete (only when usageCount === 0), and merge
// duplicates into a single keep target.

import React, { useEffect, useMemo, useState } from 'react';
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
  GitMerge,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react-native';
import { useAppActions, useAppState } from '../../store/AppContext';
import LoadingPot from '../../components/LoadingPot';
import EmptyState from '../../components/EmptyState';
import IngredientFormModal from './IngredientFormModal';
import { CATEGORY_ORDER } from '#shared/constants';
import { COLORS, SHADOWS } from '../../theme';

const UNCATEGORIZED = 'Uncategorized';

export default function IngredientsTab({ navigation, scrollPaddingBottom, fabBottom }) {
  const state = useAppState();
  const actions = useAppActions();
  const isAdmin = !!state.currentUser?.is_admin;
  const isLoggedIn = !!state.currentUser;
  const search = (state.managerSearch || '').toLowerCase().trim();

  useEffect(() => {
    actions.loadAllIngredients();
    const unsub = navigation.addListener('focus', () => actions.loadAllIngredients());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [form, setForm] = useState(null); // { mode, ingredient }

  function openAdd() {
    setForm({ mode: 'add', ingredient: null });
  }
  function openEdit(ingredient) {
    setForm({ mode: 'edit', ingredient });
  }
  function closeForm() {
    setForm(null);
  }

  // Group ingredients by category. Each ingredient row carries its own
  // `category` field; fall back to the legacy `state.ingredientCategories`
  // mapping (lowercased name → category) for any rows that haven't been
  // backfilled. Rows still without a category land under "Uncategorized".
  const grouped = useMemo(() => {
    const cats = state.ingredientCategories || {};
    const groups = {};
    for (const ingredient of state.managerIngredients || []) {
      if (search && !(ingredient.name || '').toLowerCase().includes(search)) continue;
      const key = (ingredient.name || '').toLowerCase();
      const category = ingredient.category || cats[key] || cats[ingredient.name] || UNCATEGORIZED;
      if (!groups[category]) groups[category] = [];
      groups[category].push(ingredient);
    }
    // Sort each group's rows alphabetically.
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    return groups;
  }, [state.managerIngredients, state.ingredientCategories, search]);

  const orderedCategories = useMemo(() => {
    const present = Object.keys(grouped);
    const ordered = [];
    for (const c of CATEGORY_ORDER) if (grouped[c]) ordered.push(c);
    for (const c of present.sort()) {
      if (!ordered.includes(c) && c !== UNCATEGORIZED) ordered.push(c);
    }
    if (grouped[UNCATEGORIZED]) ordered.push(UNCATEGORIZED);
    return ordered;
  }, [grouped]);

  function toggleSection(category) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    actions.toggleIngredientSection(category);
  }

  async function handleDelete(ingredient) {
    if (ingredient.usageCount > 0) {
      Alert.alert(
        `Cannot delete "${ingredient.name}"`,
        `It's used by ${ingredient.usageCount} recipe step row${ingredient.usageCount === 1 ? '' : 's'}. ` +
          'Merge it into another ingredient first, then delete.',
      );
      return;
    }
    Alert.alert(`Delete "${ingredient.name}"?`, 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const res = await actions.deleteIngredient(ingredient.id);
          if (!res.ok) Alert.alert('Could not delete', res.error || 'Unknown error');
        },
      },
    ]);
  }

  function startMergeAt(ingredient) {
    actions.startIngredientMerge(ingredient.id);
  }

  function handleMergeRowTap(ingredient) {
    if (ingredient.id === state.ingredientMerge?.keepId) return;
    actions.toggleIngredientMergePick(ingredient.id);
  }

  async function commitMerge() {
    const res = await actions.commitIngredientMerge();
    if (!res.ok && res.error) Alert.alert('Could not merge', res.error);
  }

  const merge = state.ingredientMerge;
  const isMerging = !!merge;
  const keepIngredient = isMerging ? (state.managerIngredients || []).find((f) => f.id === merge.keepId) : null;

  return (
    <View style={{ flex: 1 }}>
      {isMerging ? (
        <View style={styles.mergePanel}>
          <Text style={styles.mergePanelTitle}>
            Merging into <Text style={{ fontWeight: '900' }}>{keepIngredient?.name || '?'}</Text>
          </Text>
          <Text style={styles.mergePanelHelp}>
            Tap other ingredients to mark them as duplicates. They'll be repointed to the parent.
          </Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: scrollPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {state.managerIngredientsLoading && (state.managerIngredients || []).length === 0 ? (
          <LoadingPot label="Loading ingredients…" />
        ) : state.managerIngredientsError ? (
          <EmptyState
            title="Couldn't load ingredients"
            body={state.managerIngredientsError}
            action="Try again"
            onAction={() => actions.loadAllIngredients()}
          />
        ) : orderedCategories.length === 0 ? (
          <EmptyState
            title="No ingredients yet"
            body={search ? 'Try a different search term.' : isLoggedIn ? 'Tap the + button to add one.' : 'Sign in to contribute.'}
          />
        ) : (
          orderedCategories.map((category) => {
            const list = grouped[category];
            const isOpen = state.expandedIngredientSections.has(category);
            return (
              <View key={category} style={styles.sectionCard}>
                <TouchableOpacity
                  style={styles.sectionHeader}
                  onPress={() => toggleSection(category)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.sectionLabel}>{category}</Text>
                  <Text style={styles.sectionCount}>{list.length}</Text>
                  <Text style={[styles.chev, isOpen && styles.chevOpen]}>▾</Text>
                </TouchableOpacity>
                {isOpen ? (
                  <View style={styles.rows}>
                    {list.map((ingredient, i) => (
                      <IngredientRow
                        key={ingredient.id}
                        ingredient={ingredient}
                        isLast={i === list.length - 1}
                        isAdmin={isAdmin}
                        merge={merge}
                        onEdit={() => openEdit(ingredient)}
                        onDelete={() => handleDelete(ingredient)}
                        onLongPress={() => isAdmin && !isMerging && startMergeAt(ingredient)}
                        onMergeTap={() => handleMergeRowTap(ingredient)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      {isMerging ? (
        <View style={[styles.mergeBar, { paddingBottom: Math.max(12, fabBottom - 32) }]}>
          <Text style={styles.mergeBarText}>
            {merge.mergeIds.size === 0
              ? 'Tap rows to mark as duplicates'
              : `${merge.mergeIds.size} to merge into ${keepIngredient?.name || '?'}`}
          </Text>
          <View style={styles.mergeBarActions}>
            <TouchableOpacity
              style={styles.mergeCancelBtn}
              onPress={() => actions.cancelIngredientMerge()}
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
      ) : isLoggedIn ? (
        <TouchableOpacity
          style={[styles.fab, { bottom: fabBottom }]}
          onPress={openAdd}
          activeOpacity={0.85}
        >
          <Plus size={26} color="#fff" />
        </TouchableOpacity>
      ) : null}

      <IngredientFormModal
        visible={!!form}
        mode={form?.mode}
        ingredient={form?.ingredient}
        onClose={closeForm}
      />
    </View>
  );
}

function IngredientRow({ ingredient, isLast, isAdmin, merge, onEdit, onDelete, onLongPress, onMergeTap }) {
  const isMerging = !!merge;
  const isKeep = merge?.keepId === ingredient.id;
  const isPicked = merge?.mergeIds?.has(ingredient.id);
  const usage = ingredient.usageCount || 0;
  const sauceCount = ingredient.sauceCount || 0;
  const subtitle = sauceCount === 0
    ? 'unused'
    : `${sauceCount} sauce${sauceCount === 1 ? '' : 's'}`;

  const rowStyle = [
    styles.row,
    !isLast && styles.rowBorder,
    isKeep && styles.rowKeep,
    isPicked && styles.rowPicked,
  ];

  return (
    <TouchableOpacity
      style={rowStyle}
      onPress={isMerging ? onMergeTap : undefined}
      onLongPress={isAdmin && !isMerging ? onLongPress : undefined}
      delayLongPress={350}
      activeOpacity={isMerging ? 0.7 : 1}
    >
      <View style={styles.rowMain}>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>
            {ingredient.name}
            {ingredient.plural && ingredient.plural !== ingredient.name ? (
              <Text style={styles.rowPlural}> · {ingredient.plural}</Text>
            ) : null}
          </Text>
          <Text
            style={[
              styles.rowSubtitle,
              usage === 0 && styles.rowSubtitleMuted,
            ]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        </View>
        {isMerging ? (
          isKeep ? (
            <View style={[styles.tag, styles.tagKeep]}>
              <Text style={styles.tagLabel}>parent</Text>
            </View>
          ) : isPicked ? (
            <View style={[styles.tag, styles.tagPicked]}>
              <Text style={styles.tagLabel}>will merge</Text>
            </View>
          ) : null
        ) : null}
      </View>
      {isAdmin && !isMerging ? (
        <View style={styles.rowActions}>
          <TouchableOpacity onPress={onEdit} style={styles.actionBtn} hitSlop={6}>
            <Pencil size={13} color={COLORS.primary} />
            <Text style={styles.actionLabel}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} style={styles.actionBtn} hitSlop={6}>
            <Trash2 size={13} color={COLORS.dangerText} />
            <Text style={[styles.actionLabel, { color: COLORS.dangerText }]}>Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onLongPress} style={styles.actionBtn} hitSlop={6}>
            <GitMerge size={13} color={COLORS.textSecondary} />
            <Text style={[styles.actionLabel, { color: COLORS.textSecondary }]}>Merge into…</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16 },
  mergePanel: {
    backgroundColor: COLORS.warning,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.warningText,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  mergePanelTitle: { fontSize: 13, fontWeight: '800', color: COLORS.warningText },
  mergePanelHelp: { fontSize: 11, color: COLORS.warningText, marginTop: 2 },
  sectionCard: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  sectionLabel: { flex: 1, fontSize: 14, fontWeight: '800', color: COLORS.text },
  sectionCount: { fontSize: 12, color: COLORS.textMuted, marginRight: 8 },
  chev: { fontSize: 14, color: COLORS.textMuted },
  chevOpen: { transform: [{ rotate: '180deg' }] },
  rows: { borderTopWidth: 1, borderTopColor: COLORS.surfaceSubtle },
  row: { paddingHorizontal: 14, paddingVertical: 10 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#F9FAFB' },
  rowKeep: { backgroundColor: '#FFF3E0' },
  rowPicked: { backgroundColor: '#FEF9C3' },
  rowMain: { flexDirection: 'row', alignItems: 'center' },
  rowInfo: { flex: 1, marginRight: 8 },
  rowName: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  rowPlural: { fontSize: 12, fontWeight: '500', color: COLORS.textMuted },
  rowSubtitle: { fontSize: 11, color: COLORS.textSecondary, marginTop: 1 },
  rowSubtitleMuted: { fontStyle: 'italic', color: COLORS.textMuted },
  rowActions: { flexDirection: 'row', marginTop: 6, gap: 14, flexWrap: 'wrap' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginRight: 6,
  },
  actionLabel: { fontSize: 12, fontWeight: '700', color: COLORS.primary, marginLeft: 4 },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginLeft: 6 },
  tagKeep: { backgroundColor: COLORS.primary },
  tagPicked: { backgroundColor: '#FBBF24' },
  tagLabel: { fontSize: 10, fontWeight: '800', color: '#fff', letterSpacing: 0.3 },

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
  mergeBarText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.text,
  },
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
