import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { COLORS } from '../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * CuisineAccordion
 *
 * A single collapsible cuisine group containing sauce rows.
 *
 * Props:
 *   cuisine         string
 *   cuisineEmoji    string
 *   sauces          Sauce[]
 *   isOpen          boolean
 *   disabledIngredients  Set<string>
 *   onToggle        () => void
 *   onSelectSauce   (sauce) => void
 */
export default function CuisineAccordion({
  cuisine,
  cuisineEmoji,
  sauces,
  isOpen,
  disabledIngredients,
  onToggle,
  onSelectSauce,
}) {
  function isSauceAvailable(sauce) {
    return sauce.ingredients.every(ing => !disabledIngredients.has(ing.name));
  }

  function getMissing(sauce) {
    return sauce.ingredients
      .filter(ing => disabledIngredients.has(ing.name))
      .map(ing => ing.name);
  }

  const availableCount = sauces.filter(isSauceAvailable).length;

  function handleToggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    onToggle();
  }

  return (
    <View style={[styles.group, isOpen && styles.groupOpen]}>
      {/* Header */}
      <TouchableOpacity style={styles.header} onPress={handleToggle} activeOpacity={0.8}>
        <Text style={styles.flag}>{cuisineEmoji}</Text>
        <Text style={styles.cuisineName}>{cuisine}</Text>
        <Text style={styles.count}>
          {availableCount}/{sauces.length}
        </Text>
        <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>▾</Text>
      </TouchableOpacity>

      {/* Sauce list */}
      {isOpen && (
        <View style={styles.sauceList}>
          {sauces.map((sauce, i) => {
            const available = isSauceAvailable(sauce);
            const missing = getMissing(sauce);
            const isLast = i === sauces.length - 1;

            return (
              <TouchableOpacity
                key={sauce.id}
                style={[
                  styles.sauceRow,
                  !isLast && styles.sauceRowBorder,
                  !available && styles.sauceRowUnavailable,
                ]}
                onPress={() => available && onSelectSauce(sauce)}
                activeOpacity={available ? 0.7 : 1}
              >
                {/* Colour dot */}
                <View style={[styles.dot, { backgroundColor: sauce.color }]} />

                {/* Text info */}
                <View style={styles.sauceInfo}>
                  <Text style={[styles.sauceName, !available && styles.textFaded]}>
                    {sauce.name}
                  </Text>
                  {missing.length > 0 ? (
                    <Text style={styles.missingLabel} numberOfLines={1}>
                      Missing: {missing.join(', ')}
                    </Text>
                  ) : (
                    <Text style={styles.carbsLabel} numberOfLines={1}>
                      {sauce.compatibleCarbs.join(' · ')}
                    </Text>
                  )}
                </View>

                {/* Right badge / arrow */}
                {available ? (
                  <Text style={styles.arrow}>›</Text>
                ) : (
                  <View style={styles.missingBadge}>
                    <Text style={styles.missingBadgeText}>−{missing.length}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  groupOpen: {
    shadowOpacity: 0.10,
    elevation: 5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  flag: {
    fontSize: 22,
    marginRight: 10,
  },
  cuisineName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    flex: 1,
  },
  count: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginRight: 8,
  },
  chevron: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  sauceList: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  sauceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  sauceRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#F9FAFB',
  },
  sauceRowUnavailable: {
    opacity: 0.45,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 12,
    flexShrink: 0,
  },
  sauceInfo: {
    flex: 1,
    marginRight: 8,
  },
  sauceName: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  textFaded: {
    color: COLORS.textMuted,
  },
  carbsLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  missingLabel: {
    fontSize: 11,
    color: '#EF4444',
    marginTop: 1,
  },
  arrow: {
    fontSize: 20,
    color: COLORS.textMuted,
    fontWeight: '300',
  },
  missingBadge: {
    backgroundColor: COLORS.danger,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  missingBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.dangerText,
  },
});
