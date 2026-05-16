// Ingredient pantry filter. Groups by category — "Key Ingredients" first
// (those used in ≥30% of sauces), then the rest by category. Tapping a chip
// toggles whether the user has it. Mirrors web/sauces.js filter panel.

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  LayoutAnimation,
} from 'react-native';
import { Star, Check, X, ShoppingCart } from 'lucide-react-native';
import { groupIngredientsByCategory } from '#shared/filter';
import { COLORS } from '../theme';

export default function IngredientFilterPanel({
  ingredients,
  sauces,
  ingredientCategories,
  disabledIngredients,
  isOpen,
  onToggleOpen,
  onToggleIngredient,
  onClear,
}) {
  const missingCount = disabledIngredients.size;

  function handleHeaderPress() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    onToggleOpen(!isOpen);
  }

  const groups = groupIngredientsByCategory({
    sauces: sauces || [],
    allIngredients: ingredients || [],
    ingredientCategories: ingredientCategories || {},
  });

  return (
    <View style={styles.panel}>
      <TouchableOpacity style={styles.header} onPress={handleHeaderPress} activeOpacity={0.8}>
        <ShoppingCart size={18} color={COLORS.primary} />
        <Text style={styles.headerText}>My Pantry</Text>
        {missingCount > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>−{missingCount} missing</Text>
          </View>
        ) : null}
        <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>▾</Text>
      </TouchableOpacity>

      {isOpen ? (
        <View style={styles.body}>
          <Text style={styles.hint}>
            Uncheck ingredients you don't have — options will update.
          </Text>

          {groups.map(({ category, items, isKey }) => (
            <View key={category} style={styles.section}>
              <View style={styles.sectionHeader}>
                {isKey ? <Star size={12} color={COLORS.primary} /> : null}
                <Text style={styles.sectionLabel}>{category}</Text>
                {isKey ? (
                  <Text style={styles.sectionLabelDetail}>— unlock the most options</Text>
                ) : null}
              </View>
              <View style={styles.chips}>
                {items.map(({ name }) => {
                  const has = !disabledIngredients.has(name);
                  return (
                    <TouchableOpacity
                      key={name}
                      style={[styles.chip, has ? styles.chipHas : styles.chipMissing]}
                      onPress={() => onToggleIngredient(name)}
                      activeOpacity={0.7}
                    >
                      {has ? (
                        <Check size={11} color="#065F46" />
                      ) : (
                        <X size={11} color="#991B1B" />
                      )}
                      <Text style={[styles.chipLabel, !has && styles.chipLabelMissing]}>
                        {name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}

          {missingCount > 0 ? (
            <TouchableOpacity style={styles.resetBtn} onPress={onClear} activeOpacity={0.7}>
              <Text style={styles.resetText}>Reset — I have everything</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  headerText: {
    marginLeft: 8,
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    flex: 1,
  },
  badge: {
    backgroundColor: COLORS.danger,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.dangerText,
  },
  chevron: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  body: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.surfaceSubtle,
  },
  hint: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 10,
    marginBottom: 10,
    lineHeight: 16,
  },
  // Mirrors web's .ingredient-section + .ingredient-section-label:
  // uppercase, letter-spaced, no highlighted background for the "Key
  // Ingredients" group — just a star + label + "unlock the most options"
  // detail. Less visual noise, matches web exactly.
  section: {
    marginBottom: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  sectionLabelDetail: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginLeft: 2,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipHas: {
    backgroundColor: '#F0FDF4',
    borderColor: '#D1FAE5',
  },
  chipMissing: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FEE2E2',
    opacity: 0.7,
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#065F46',
  },
  chipLabelMissing: {
    color: '#991B1B',
    textDecorationLine: 'line-through',
  },
  resetBtn: {
    marginTop: 12,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
  },
  resetText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.primary,
  },
});
