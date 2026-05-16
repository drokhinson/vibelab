// PantryScreen — user's negative ingredient list. Mirrors web's pantry.js.
// Ingredients are grouped by category (CATEGORY_ORDER first, alphabetical
// fallback) into collapsible sections. Tap a row to toggle the missing
// flag; that change is mirrored into disabledIngredients so the
// meal-builder filter sees the same state.

import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { ChevronDown, ChevronsUpDown, Check, RefreshCcw, X } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import LoadingPot from '../components/LoadingPot';
import { CATEGORY_ORDER } from '#shared/constants';
import { capitalizeIngredient } from '#shared/text';
import { COLORS, SHADOWS } from '../theme';

export default function PantryScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const p = state.pantry;

  // Group ingredients by category. Categories in CATEGORY_ORDER come first
  // in that order; anything else falls into "Pantry Staples" / alphabetical
  // tail.
  const groups = useMemo(() => {
    const byCat = new Map();
    for (const ing of p.ingredients) {
      const cat = ing.category || 'Pantry Staples';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(ing);
    }
    for (const arr of byCat.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    const ordered = [];
    for (const c of CATEGORY_ORDER) {
      if (byCat.has(c)) {
        ordered.push({ category: c, items: byCat.get(c) });
        byCat.delete(c);
      }
    }
    for (const [category, items] of [...byCat.entries()].sort()) {
      ordered.push({ category, items });
    }
    return ordered;
  }, [p.ingredients]);

  // Quick-action handlers wired to the two header buttons. Both read the
  // currently-visible category list so the toggle/collapse covers exactly
  // what the user can see.
  const anyOpen = useMemo(
    () => groups.some((g) => p.openSections.has(g.category)),
    [groups, p.openSections],
  );
  const onRestock = () => actions.restockPantry();
  const onToggleAll = () =>
    actions.setAllPantrySections(groups.map((g) => g.category), !anyOpen);

  const totals = useMemo(() => {
    const total = p.ingredients.length;
    const missing = p.ingredients.filter((i) => i.missing).length;
    return { total, missing };
  }, [p.ingredients]);

  if (!state.currentUser) {
    return (
      <View style={styles.screen}>
        <AppHeader title="Pantry" subtitle="Mark what you're out of" navigation={navigation} />
        <EmptyState
          title="Sign in to track your pantry"
          body="Pantry mirrors the ingredients your saucebook recipes need."
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        title="Pantry"
        subtitle={
          totals.total > 0
            ? `${totals.total} saucebook ingredients · ${totals.missing} missing`
            : "Mark what you're out of"
        }
        navigation={navigation}
      />

      {p.ingredients.length > 0 ? (
        <View style={styles.actionBar}>
          <TouchableOpacity
            style={[styles.actionBtn, totals.missing === 0 && styles.actionBtnDisabled]}
            onPress={onRestock}
            disabled={totals.missing === 0}
            activeOpacity={0.8}
          >
            <RefreshCcw size={14} color={totals.missing === 0 ? COLORS.textMuted : COLORS.primary} />
            <Text style={[styles.actionBtnLabel, totals.missing === 0 && styles.actionBtnLabelDisabled]}>
              Restock
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={onToggleAll}
            activeOpacity={0.8}
          >
            <ChevronsUpDown size={14} color={COLORS.primary} />
            <Text style={styles.actionBtnLabel}>{anyOpen ? 'Collapse all' : 'Expand all'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {p.loading && p.ingredients.length === 0 ? (
        <LoadingPot label="Loading your pantry…" />
      ) : p.error && p.ingredients.length === 0 ? (
        <EmptyState
          title="Couldn't load your pantry"
          body={p.error}
          action="Try again"
          onAction={actions.loadPantry}
        />
      ) : p.ingredients.length === 0 ? (
        <EmptyState
          title="Pantry is empty"
          body="Add recipes to your saucebook and their ingredients show up here."
          action="Open Browse"
          onAction={() => navigation.navigate('Home', { screen: 'BrowseTab' })}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.listBody}>
          {groups.map((g) => {
            const open = p.openSections.has(g.category);
            const missing = g.items.filter((i) => i.missing).length;
            return (
              <View key={g.category} style={styles.group}>
                <TouchableOpacity
                  style={styles.groupHeader}
                  onPress={() => actions.togglePantrySection(g.category)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.groupHeaderText} numberOfLines={1}>
                    {g.category}
                  </Text>
                  <View
                    style={[
                      styles.groupCountBadge,
                      missing > 0 && styles.groupCountBadgeMissing,
                    ]}
                  >
                    <Text
                      style={[
                        styles.groupCountText,
                        missing > 0 && styles.groupCountTextMissing,
                      ]}
                    >
                      {g.items.length - missing}/{g.items.length}
                    </Text>
                  </View>
                  <ChevronDown
                    size={16}
                    color={COLORS.textSecondary}
                    style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
                  />
                </TouchableOpacity>
                {open
                  ? g.items.map((ing) => (
                      <TouchableOpacity
                        key={ing.ingredientId}
                        style={styles.row}
                        onPress={() => actions.togglePantryIngredient(ing)}
                        activeOpacity={0.7}
                      >
                        <View
                          style={[
                            styles.statusDot,
                            ing.missing ? styles.statusDotMissing : styles.statusDotStocked,
                          ]}
                        >
                          {ing.missing ? (
                            <X size={12} color="#fff" />
                          ) : (
                            <Check size={12} color="#fff" />
                          )}
                        </View>
                        <View style={styles.rowBody}>
                          <Text
                            style={[styles.rowName, ing.missing && styles.rowNameMissing]}
                            numberOfLines={1}
                          >
                            {capitalizeIngredient(ing.name)}
                          </Text>
                          <Text
                            style={[styles.rowStatus, ing.missing && styles.rowStatusMissing]}
                          >
                            {ing.missing ? 'Missing' : 'In stock'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    ))
                  : null}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  // Action bar below the header — two equally-spaced pill buttons. Restock
  // greys out when nothing is missing; toggle flips label between
  // 'Collapse all' / 'Expand all' based on the current open state.
  actionBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  actionBtnDisabled: {
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    opacity: 0.6,
  },
  actionBtnLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
  },
  actionBtnLabelDisabled: {
    color: COLORS.textMuted,
  },
  listBody: {
    padding: 12,
    paddingBottom: 32,
  },
  group: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
    ...SHADOWS.sm,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  groupHeaderText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
    color: COLORS.text,
  },
  groupCountBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: '#FED7AA',
  },
  groupCountBadgeMissing: {
    backgroundColor: '#DC2626',
  },
  groupCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9A3412',
  },
  groupCountTextMissing: {
    color: '#fff',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.surfaceSubtle,
  },
  statusDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDotStocked: { backgroundColor: COLORS.successText },
  statusDotMissing: { backgroundColor: COLORS.dangerText },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowName: { fontSize: 13, fontWeight: '600', color: COLORS.text, flexShrink: 1 },
  rowNameMissing: { color: COLORS.textMuted },
  rowStatus: { fontSize: 12, fontWeight: '700', color: COLORS.successText },
  rowStatusMissing: { color: COLORS.dangerText },
});
