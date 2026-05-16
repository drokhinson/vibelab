// Cuisine accordion — collapsible group of sauce families. Mirrors web's
// renderCuisineGroup helper (web/helpers.js:485). Used by Saucebook, the
// Sauce Selector flow, and the Sauce Manager so the orange/uppercase
// header chrome stays identical across screens.
//
// Props:
//   cuisine, cuisineEmoji
//   entries  [{ family, displayed }]   — pre-grouped via buildSauceFamilies + pickDisplayedFromFamily
//   isOpen   boolean
//   disabledIngredients  Set<string>   — used for default available/missing logic
//   onToggle ()=>void
//   onSelectSauce  (sauce, family) => void
//   renderRow      optional ({ family, displayed, isLast, isOpen }) => ReactNode
//                  — overrides the default SauceRow render so callers
//                    (Manager) can plug in their own row body while reusing
//                    the cuisine header chrome.
//   countLabel     optional string — overrides the default "available/total"
//                    count shown in the header.

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  LayoutAnimation,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { isSauceAvailable, missingSauceIngredients } from '#shared/filter';
import SauceRow from './SauceRow';
import { COLORS } from '../theme';

export default function CuisineAccordion({
  cuisine,
  cuisineEmoji,
  entries,
  isOpen,
  disabledIngredients,
  onToggle,
  onSelectSauce,
  renderRow,
  countLabel,
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
          {countLabel != null ? countLabel : `${availableCount}/${entries.length}`}
        </Text>
        <Text style={[styles.chevron, isOpen && styles.chevronOpen]}>▾</Text>
      </TouchableOpacity>

      {isOpen ? (
        <View style={styles.sauceList}>
          {entries.map(({ family, displayed }, i) => {
            const isLast = i === entries.length - 1;
            // Manager (and any caller passing renderRow) gets full control of
            // the row body — typically a richer cell with action buttons.
            if (renderRow) {
              return (
                <React.Fragment key={displayed.id}>
                  {renderRow({ family, displayed, isLast, isOpen })}
                </React.Fragment>
              );
            }
            const sauce = displayed;
            const totalVersions = 1 + family.variants.length;
            const available = isSauceAvailable(sauce, disabledIngredients);
            const missing = missingSauceIngredients(sauce, disabledIngredients);
            const subline = missing.length > 0
              ? `Missing: ${missing.join(', ')}`
              : (sauce.description || null);
            const rightSlot = available ? (
              <ChevronRight size={18} color={COLORS.textMuted} />
            ) : (
              <View style={styles.missingBadge}>
                <Text style={styles.missingBadgeText}>−{missing.length}</Text>
              </View>
            );
            return (
              <SauceRow
                key={sauce.id}
                sauce={sauce}
                subline={subline}
                variantCount={totalVersions}
                rightSlot={rightSlot}
                onPress={() => onSelectSauce && onSelectSauce(sauce, family)}
                disabled={!available}
                faded={!available}
                isLast={isLast}
              />
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
