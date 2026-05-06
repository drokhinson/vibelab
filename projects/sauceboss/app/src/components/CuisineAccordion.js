// Cuisine accordion — collapsible group of sauce families.
// Reads filter logic from #shared so behavior stays in lockstep with web.
//
// Props:
//   cuisine, cuisineEmoji
//   entries  [{ family, displayed }]   — pre-grouped from buildSauceFamilies + pickDisplayedFromFamily
//   isOpen   boolean
//   disabledIngredients  Set<string>
//   onToggle ()=>void
//   onSelectSauce  (sauce, family) => void

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { ChevronRight, GitBranch } from 'lucide-react-native';
import { isSauceAvailable, missingSauceIngredients } from '#shared/filter';
import { COLORS } from '../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function CuisineAccordion({
  cuisine,
  cuisineEmoji,
  entries,
  isOpen,
  disabledIngredients,
  onToggle,
  onSelectSauce,
}) {
  const availableCount = entries.filter((e) => isSauceAvailable(e.displayed, disabledIngredients)).length;

  function handleToggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    onToggle();
  }

  return (
    <View style={[styles.group, isOpen && styles.groupOpen]}>
      <TouchableOpacity style={styles.header} onPress={handleToggle} activeOpacity={0.8}>
        <Text style={styles.flag}>{cuisineEmoji}</Text>
        <Text style={styles.cuisineName}>{cuisine}</Text>
        <Text style={styles.count}>
          {availableCount}/{entries.length}
        </Text>
        <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>▾</Text>
      </TouchableOpacity>

      {isOpen ? (
        <View style={styles.sauceList}>
          {entries.map(({ family, displayed }, i) => {
            const sauce = displayed;
            const totalVersions = 1 + family.variants.length;
            const available = isSauceAvailable(sauce, disabledIngredients);
            const missing = missingSauceIngredients(sauce, disabledIngredients);
            const isLast = i === entries.length - 1;

            return (
              <TouchableOpacity
                key={sauce.id}
                style={[
                  styles.sauceRow,
                  !isLast && styles.sauceRowBorder,
                  !available && styles.sauceRowUnavailable,
                ]}
                onPress={() => available && onSelectSauce(sauce, family)}
                activeOpacity={available ? 0.7 : 1}
              >
                <View style={[styles.dot, { backgroundColor: sauce.color || COLORS.primary }]} />

                <View style={styles.sauceInfo}>
                  <View style={styles.sauceNameRow}>
                    <Text
                      style={[styles.sauceName, !available && styles.textFaded]}
                      numberOfLines={1}
                    >
                      {sauce.name}
                    </Text>
                    {totalVersions > 1 ? (
                      <View style={styles.variantBadge}>
                        <GitBranch size={10} color={COLORS.textSecondary} />
                        <Text style={styles.variantBadgeText}>{totalVersions}</Text>
                      </View>
                    ) : null}
                  </View>
                  {missing.length > 0 ? (
                    <Text style={styles.missingLabel} numberOfLines={1}>
                      Missing: {missing.join(', ')}
                    </Text>
                  ) : sauce.description ? (
                    <Text style={styles.descLabel} numberOfLines={1}>
                      {sauce.description}
                    </Text>
                  ) : null}
                </View>

                {available ? (
                  <ChevronRight size={18} color={COLORS.textMuted} />
                ) : (
                  <View style={styles.missingBadge}>
                    <Text style={styles.missingBadgeText}>−{missing.length}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
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
    shadowOpacity: 0.1,
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
    borderTopColor: COLORS.surfaceSubtle,
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
  },
  sauceInfo: {
    flex: 1,
    marginRight: 8,
  },
  sauceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sauceName: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    flexShrink: 1,
  },
  textFaded: {
    color: COLORS.textMuted,
  },
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
  descLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  missingLabel: {
    fontSize: 11,
    color: '#EF4444',
    marginTop: 1,
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
