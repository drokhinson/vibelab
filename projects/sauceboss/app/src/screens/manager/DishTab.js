// Dish (items) tab — three collapsible sections (Carbs / Proteins / Salads),
// each listing parents with their nested variants. Read-only for everyone;
// admins additionally see Edit / Delete row actions and a "+ Add" button per
// section + per parent (for variants). Mirrors the web's renderDishTab.

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  Alert,
  LayoutAnimation,
} from 'react-native';
import { Pencil, Plus, Trash2 } from 'lucide-react-native';
import { useAppActions, useAppState } from '../../store/AppContext';
import LoadingPot from '../../components/LoadingPot';
import EmptyState from '../../components/EmptyState';
import ItemFormModal from './ItemFormModal';
import { COLORS, SHADOWS } from '../../theme';

const SECTIONS = [
  { key: 'carbs', category: 'carb', label: 'Carbs', emptyText: 'No carbs yet.' },
  { key: 'proteins', category: 'protein', label: 'Proteins', emptyText: 'No proteins yet.' },
  { key: 'salads', category: 'salad', label: 'Salads', emptyText: 'No salads yet.' },
];

export default function DishTab({ navigation, scrollPaddingBottom }) {
  const state = useAppState();
  const actions = useAppActions();
  const isAdmin = !!state.currentUser?.is_admin;
  const search = (state.managerSearch || '').toLowerCase().trim();

  // Refresh on focus mirrors SaucesTab behavior so newly-saved items appear.
  useEffect(() => {
    actions.loadAllItems();
    const unsub = navigation.addListener('focus', () => actions.loadAllItems());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [form, setForm] = useState(null); // { mode, category, parentId, parentName, item }

  function openAdd(category, parentId = null, parentName = null) {
    setForm({ mode: 'add', category, parentId, parentName, item: null });
  }
  function openEdit(item) {
    setForm({ mode: 'edit', category: item.category, parentId: item.parentId || null, parentName: null, item });
  }
  function closeForm() {
    setForm(null);
  }

  function confirmDelete(item) {
    const variantCount = (item.variants || []).length;
    const message = variantCount > 0
      ? `Delete "${item.name}" and ALL ${variantCount} variant${variantCount === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete "${item.name}"? This cannot be undone.`;
    Alert.alert('Delete dish', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const res = await actions.deleteItem(item.id);
          if (!res.ok) Alert.alert('Could not delete', res.error || 'Unknown error');
        },
      },
    ]);
  }

  function toggleSection(key) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    actions.toggleItemSection(key);
  }

  function toggleParent(parentId) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    actions.toggleItemParent(parentId);
  }

  // Filter items + their variants by the global search box.
  const filteredItems = useMemo(() => {
    if (!search) return state.managerItems;
    function match(it) {
      return (it.name || '').toLowerCase().includes(search)
        || (it.description || '').toLowerCase().includes(search);
    }
    function filterList(list) {
      const out = [];
      for (const parent of list) {
        const variants = (parent.variants || []).filter(match);
        if (match(parent) || variants.length > 0) {
          out.push({ ...parent, variants });
        }
      }
      return out;
    }
    return {
      carbs: filterList(state.managerItems.carbs || []),
      proteins: filterList(state.managerItems.proteins || []),
      salads: filterList(state.managerItems.salads || []),
    };
  }, [state.managerItems, search]);

  const isLoading = state.managerItemsLoading
    && (filteredItems.carbs.length + filteredItems.proteins.length + filteredItems.salads.length) === 0;

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: scrollPaddingBottom }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {isLoading ? (
        <LoadingPot label="Loading dishes…" />
      ) : state.managerItemsError ? (
        <EmptyState
          title="Couldn't load dishes"
          body={state.managerItemsError}
          action="Try again"
          onAction={() => actions.loadAllItems()}
        />
      ) : (
        SECTIONS.map((sec) => {
          const list = filteredItems[sec.key] || [];
          const isOpen = state.expandedItemSections.has(sec.key);
          return (
            <View key={sec.key} style={styles.sectionCard}>
              <TouchableOpacity style={styles.sectionHeader} onPress={() => toggleSection(sec.key)} activeOpacity={0.8}>
                <Text style={styles.sectionLabel}>{sec.label}</Text>
                <Text style={styles.sectionCount}>{list.length}</Text>
                <Text style={[styles.chev, isOpen && styles.chevOpen]}>▾</Text>
              </TouchableOpacity>
              {isOpen ? (
                <View style={styles.rows}>
                  {list.length === 0 ? (
                    <Text style={styles.emptyRow}>{sec.emptyText}</Text>
                  ) : (
                    list.map((parent, i) => (
                      <ParentRow
                        key={parent.id}
                        parent={parent}
                        isLast={i === list.length - 1}
                        isAdmin={isAdmin}
                        isExpanded={state.expandedItemParents.has(parent.id)}
                        onToggleExpand={() => toggleParent(parent.id)}
                        onEdit={() => openEdit(parent)}
                        onDelete={() => confirmDelete(parent)}
                        onAddVariant={() => openAdd(sec.category, parent.id, parent.name)}
                        onEditVariant={(v) => openEdit({ ...v, category: sec.category, parentId: parent.id })}
                        onDeleteVariant={(v) => confirmDelete({ ...v, category: sec.category, parentId: parent.id })}
                      />
                    ))
                  )}
                  {isAdmin ? (
                    <TouchableOpacity
                      style={styles.addRow}
                      onPress={() => openAdd(sec.category, null, null)}
                      activeOpacity={0.7}
                    >
                      <Plus size={14} color={COLORS.primary} />
                      <Text style={styles.addRowLabel}>Add {sec.label.slice(0, -1).toLowerCase()}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })
      )}

      <ItemFormModal
        visible={!!form}
        mode={form?.mode}
        category={form?.category}
        parentId={form?.parentId}
        parentName={form?.parentName}
        item={form?.item}
        onClose={closeForm}
      />
    </ScrollView>
  );
}

function ParentRow({
  parent,
  isLast,
  isAdmin,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onAddVariant,
  onEditVariant,
  onDeleteVariant,
}) {
  const variants = parent.variants || [];
  const subtitle = (() => {
    const parts = [];
    if (variants.length > 0) parts.push(`${variants.length} variant${variants.length === 1 ? '' : 's'}`);
    if (parent.cookTimeMinutes) parts.push(`${parent.cookTimeMinutes} min`);
    if (parent.description) parts.push(parent.description);
    return parts.join(' · ');
  })();

  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <TouchableOpacity
        style={styles.rowMain}
        onPress={() => (variants.length > 0 || isAdmin ? onToggleExpand() : null)}
        activeOpacity={variants.length > 0 || isAdmin ? 0.7 : 1}
      >
        <Text style={styles.rowEmoji}>{parent.emoji || '🍽️'}</Text>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>{parent.name}</Text>
          {subtitle ? <Text style={styles.rowSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {variants.length > 0 || isAdmin ? (
          <Text style={[styles.chev, isExpanded && styles.chevOpen]}>▾</Text>
        ) : null}
      </TouchableOpacity>

      {isAdmin ? (
        <View style={styles.rowActions}>
          <TouchableOpacity onPress={onEdit} style={styles.actionBtn} hitSlop={6}>
            <Pencil size={14} color={COLORS.primary} />
            <Text style={styles.actionLabel}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} style={styles.actionBtn} hitSlop={6}>
            <Trash2 size={14} color={COLORS.dangerText} />
            <Text style={[styles.actionLabel, { color: COLORS.dangerText }]}>Delete</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {isExpanded ? (
        <View style={styles.variantsList}>
          {variants.length === 0 ? (
            <Text style={styles.variantsEmpty}>No variants yet.</Text>
          ) : (
            variants.map((v, idx) => (
              <View key={v.id} style={[styles.variantRow, idx !== variants.length - 1 && styles.variantRowBorder]}>
                <Text style={styles.variantEmoji}>{v.emoji || parent.emoji || '🍽️'}</Text>
                <View style={styles.variantInfo}>
                  <Text style={styles.variantName} numberOfLines={1}>{v.name}</Text>
                  <Text style={styles.variantSubtitle} numberOfLines={1}>
                    {[v.cookTimeMinutes ? `${v.cookTimeMinutes} min` : null, v.description].filter(Boolean).join(' · ') || ' '}
                  </Text>
                </View>
                {isAdmin ? (
                  <View style={styles.variantActions}>
                    <TouchableOpacity onPress={() => onEditVariant(v)} hitSlop={6} style={styles.variantAction}>
                      <Pencil size={13} color={COLORS.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => onDeleteVariant(v)} hitSlop={6} style={styles.variantAction}>
                      <Trash2 size={13} color={COLORS.dangerText} />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            ))
          )}
          {isAdmin ? (
            <TouchableOpacity style={styles.addVariantBtn} onPress={onAddVariant} activeOpacity={0.7}>
              <Plus size={13} color={COLORS.primary} />
              <Text style={styles.addVariantLabel}>Add variant of {parent.name}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16 },
  sectionCard: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  sectionLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
  },
  sectionCount: { fontSize: 12, color: COLORS.textMuted, marginRight: 8 },
  chev: { fontSize: 14, color: COLORS.textMuted },
  chevOpen: { transform: [{ rotate: '180deg' }] },
  rows: { borderTopWidth: 1, borderTopColor: COLORS.surfaceSubtle },
  emptyRow: { padding: 14, fontSize: 12, color: COLORS.textMuted, textAlign: 'center' },
  row: { paddingHorizontal: 14, paddingVertical: 10 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#F9FAFB' },
  rowMain: { flexDirection: 'row', alignItems: 'center' },
  rowEmoji: { fontSize: 22, width: 28, textAlign: 'center', marginRight: 8 },
  rowInfo: { flex: 1, marginRight: 8 },
  rowName: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  rowSubtitle: { fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  rowActions: { flexDirection: 'row', marginTop: 6, paddingLeft: 36, gap: 14 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginRight: 6,
  },
  actionLabel: { fontSize: 12, fontWeight: '700', color: COLORS.primary, marginLeft: 4 },
  variantsList: {
    marginTop: 8,
    marginLeft: 36,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.surfaceSubtle,
  },
  variantsEmpty: {
    fontSize: 11,
    color: COLORS.textMuted,
    paddingVertical: 6,
    fontStyle: 'italic',
  },
  variantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  variantRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.surfaceSubtle,
  },
  variantEmoji: { fontSize: 16, width: 22, textAlign: 'center', marginRight: 6 },
  variantInfo: { flex: 1 },
  variantName: { fontSize: 13, fontWeight: '600', color: COLORS.text },
  variantSubtitle: { fontSize: 10, color: COLORS.textMuted, marginTop: 1 },
  variantActions: { flexDirection: 'row', gap: 8 },
  variantAction: { paddingHorizontal: 6, paddingVertical: 4 },
  addVariantBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  addVariantLabel: { fontSize: 12, fontWeight: '700', color: COLORS.primary, marginLeft: 4 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    backgroundColor: COLORS.background,
  },
  addRowLabel: { fontSize: 13, fontWeight: '700', color: COLORS.primary, marginLeft: 6 },
});
