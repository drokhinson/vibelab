// Wizard step 4 — Dish Pairing. Mirrors web's renderBuilderPairing
// (web/builder.js:553-625):
//
//   Type:    [Sauce] [Marinade] [Dressing] [Dip/Spread] [Full Recipe]
//   Tree:    ▶ 🍝 Pasta  3       (parent — tap chevron to expand)
//              ◇ Spaghetti       (variants when expanded)
//              ◇ Linguine
//              …
//
// Parent checkbox is tri-state:
//   - empty   : nothing selected under this dish
//   - partial : some variants selected (or only the parent id)
//   - checked : all variants selected (and parent id auto-included)
//
// Standalone types (sauceType.category === null) skip the tree entirely
// and show a hint instead. Switching type wipes the current itemIds —
// matches web's builderSetSauceType behavior.

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ChevronRight, Check, Minus } from 'lucide-react-native';
import { SAUCE_TYPES } from '#shared/constants';
import builderStyles from './builderStyles';
import { COLORS } from '../../theme';

function dishPool(items, sauceType) {
  const meta = SAUCE_TYPES.find((t) => t.value === sauceType);
  if (!meta || meta.category === null) return [];
  if (meta.category === 'protein') return items.proteins || [];
  if (meta.category === 'salad') return items.salads || [];
  return items.carbs || [];
}

export default function PairingStep({
  builder,
  items,
  setSauceType,
  setItemIds,
}) {
  // Expand state lives in the component — web stores it on the builder so
  // it survives unmounts; native step components unmount when the wizard
  // moves so local state is fine (matches the "expand on visit" UX).
  const [expanded, setExpanded] = useState(() => new Set());
  function toggleExpand(dishId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dishId)) next.delete(dishId);
      else next.add(dishId);
      return next;
    });
  }

  const meta = SAUCE_TYPES.find((t) => t.value === builder.sauceType);
  const isStandalone = meta && meta.category === null;
  const pool = dishPool(items, builder.sauceType);

  function toggleItem(id) {
    const has = builder.itemIds.includes(id);
    setItemIds(has ? builder.itemIds.filter((x) => x !== id) : [...builder.itemIds, id]);
  }

  function toggleDishParent(dish) {
    const variants = dish.variants || dish.subtypes || [];
    if (variants.length === 0) {
      toggleItem(dish.id);
      return;
    }
    const variantIds = variants.map((v) => v.id);
    const allSelected = variantIds.every((id) => builder.itemIds.includes(id));
    if (allSelected) {
      // Deselect everything in this group, including the parent id.
      setItemIds(
        builder.itemIds.filter((id) => !variantIds.includes(id) && id !== dish.id),
      );
    } else {
      // Select every variant + the parent id, deduped.
      const next = new Set(builder.itemIds);
      for (const vid of variantIds) next.add(vid);
      next.add(dish.id);
      setItemIds([...next]);
    }
  }

  function checkState(dish) {
    const variants = dish.variants || dish.subtypes || [];
    const dishSelected = builder.itemIds.includes(dish.id);
    if (variants.length === 0) return dishSelected ? 'checked' : 'empty';
    const variantIds = variants.map((v) => v.id);
    const all = variantIds.every((id) => builder.itemIds.includes(id));
    const some = variantIds.some((id) => builder.itemIds.includes(id));
    if (all || dishSelected) return 'checked';
    if (some) return 'partial';
    return 'empty';
  }

  return (
    <View style={builderStyles.card}>
      <Text style={[builderStyles.fieldHeader, { marginTop: 4 }]}>Type</Text>
      <View style={styles.typeRow}>
        {SAUCE_TYPES.map((t) => {
          const active = builder.sauceType === t.value;
          return (
            <TouchableOpacity
              key={t.value}
              onPress={() => setSauceType(t.value)}
              style={[styles.typeChip, active && styles.typeChipActive]}
              activeOpacity={0.8}
            >
              <Text style={[styles.typeChipLabel, active && styles.typeChipLabelActive]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {!builder.sauceType ? (
        <Text style={builderStyles.help}>Select a type above to see dish pairings.</Text>
      ) : isStandalone ? (
        <View style={styles.standaloneCard}>
          <Text style={styles.standaloneHint}>
            🍽️ Full Recipe — standalone, no dish pairing needed.
          </Text>
        </View>
      ) : pool.length === 0 ? (
        <>
          <Text style={builderStyles.fieldHeader}>Dish</Text>
          <Text style={builderStyles.help}>No {meta.pairLabel.toLowerCase()} in the catalog yet.</Text>
        </>
      ) : (
        <>
          <Text style={builderStyles.fieldHeader}>Dish</Text>
          <View style={styles.tree}>
          {pool.map((dish) => {
            const variants = dish.variants || dish.subtypes || [];
            const hasChildren = variants.length > 0;
            const isExpanded = expanded.has(dish.id);
            const state = checkState(dish);
            return (
              <View key={dish.id} style={styles.group}>
                <View style={styles.parentRow}>
                  {hasChildren ? (
                    <TouchableOpacity
                      onPress={() => toggleExpand(dish.id)}
                      style={styles.chevronBtn}
                      hitSlop={6}
                    >
                      <ChevronRight
                        size={16}
                        color={COLORS.textSecondary}
                        style={{ transform: [{ rotate: isExpanded ? '90deg' : '0deg' }] }}
                      />
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.chevronSpacer} />
                  )}
                  <CheckBox state={state} onPress={() => toggleDishParent(dish)} />
                  <TouchableOpacity
                    onPress={() => toggleDishParent(dish)}
                    style={styles.parentMain}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.emoji}>{dish.emoji || ''}</Text>
                    <Text style={styles.name} numberOfLines={1}>
                      {dish.name}
                    </Text>
                  </TouchableOpacity>
                  {hasChildren ? (
                    <Text style={styles.count}>{variants.length}</Text>
                  ) : null}
                </View>

                {hasChildren && isExpanded ? (
                  <View style={styles.children}>
                    {variants.map((v) => {
                      const vSel = builder.itemIds.includes(v.id);
                      return (
                        <TouchableOpacity
                          key={v.id}
                          onPress={() => toggleItem(v.id)}
                          style={styles.childRow}
                          activeOpacity={0.7}
                        >
                          <CheckBox state={vSel ? 'checked' : 'empty'} onPress={() => toggleItem(v.id)} />
                          <Text style={styles.emoji}>{v.emoji || ''}</Text>
                          <Text style={styles.name} numberOfLines={1}>
                            {v.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })}
          </View>
        </>
      )}
    </View>
  );
}

function CheckBox({ state, onPress }) {
  const isChecked = state === 'checked';
  const isPartial = state === 'partial';
  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={6}
      style={[
        styles.checkbox,
        (isChecked || isPartial) && styles.checkboxOn,
      ]}
      activeOpacity={0.7}
    >
      {isChecked ? <Check size={12} color="#fff" /> : null}
      {isPartial ? <Minus size={12} color="#fff" /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
    marginBottom: 12,
  },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  typeChipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  typeChipLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  typeChipLabelActive: {
    color: '#fff',
  },
  standaloneCard: {
    backgroundColor: COLORS.highlightTint,
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  standaloneHint: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primaryDark,
  },
  tree: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    overflow: 'hidden',
  },
  group: {},
  parentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  chevronBtn: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevronSpacer: {
    width: 20,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  parentMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  emoji: {
    fontSize: 18,
  },
  name: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  count: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textMuted,
    backgroundColor: COLORS.surfaceSubtle,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 20,
    textAlign: 'center',
  },
  children: {
    backgroundColor: '#FBFAF7',
    paddingLeft: 36,
  },
  childRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingRight: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
});
