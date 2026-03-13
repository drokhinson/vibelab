import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { COLORS } from '../theme';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * IngredientFilterPanel
 *
 * Shows an accordion panel with toggleable ingredient chips.
 * Checking/unchecking an ingredient calls onToggle(name).
 *
 * Props:
 *   ingredients       string[]          — all available ingredient names
 *   disabledIngredients  Set<string>    — names the user doesn't have
 *   onToggle          (name) => void
 *   unavailableCount  number            — number of hidden sauces
 */
export default function IngredientFilterPanel({
  ingredients,
  disabledIngredients,
  onToggle,
  unavailableCount,
}) {
  const [isOpen, setIsOpen] = useState(false);

  function toggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsOpen(prev => !prev);
  }

  const missingCount = disabledIngredients.size;

  return (
    <View style={styles.panel}>
      {/* Header row */}
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.8}>
        <Text style={styles.headerIcon}>🛒</Text>
        <Text style={styles.headerText}>My Pantry</Text>
        {missingCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>−{missingCount} missing</Text>
          </View>
        )}
        <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>▾</Text>
      </TouchableOpacity>

      {/* Body */}
      {isOpen && (
        <View style={styles.body}>
          <Text style={styles.hint}>
            Uncheck ingredients you don't have — sauces update instantly.
          </Text>
          <View style={styles.chips}>
            {ingredients.map(name => {
              const has = !disabledIngredients.has(name);
              return (
                <TouchableOpacity
                  key={name}
                  style={[styles.chip, has ? styles.chipHas : styles.chipMissing]}
                  onPress={() => onToggle(name)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipIcon, !has && styles.chipIconMissing]}>
                    {has ? '✓' : '✗'}
                  </Text>
                  <Text style={[styles.chipLabel, !has && styles.chipLabelMissing]}>
                    {name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {missingCount > 0 && (
            <TouchableOpacity
              style={styles.resetBtn}
              onPress={() => {
                // Signal parent to clear all disabled
                ingredients.forEach(name => {
                  if (disabledIngredients.has(name)) onToggle(name);
                });
              }}
            >
              <Text style={styles.resetText}>Reset — I have everything</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
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
  headerIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  headerText: {
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
    borderTopColor: '#F3F4F6',
  },
  hint: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 10,
    marginBottom: 10,
    lineHeight: 16,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1.5,
    marginBottom: 2,
  },
  chipHas: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  chipMissing: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
    opacity: 0.75,
  },
  chipIcon: {
    fontSize: 11,
    fontWeight: '700',
    color: '#065F46',
    marginRight: 4,
  },
  chipIconMissing: {
    color: '#991B1B',
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
