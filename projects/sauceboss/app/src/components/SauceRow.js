// Shared sauce-list row chrome. Mirrors web's renderSauceRow helper
// (web/helpers.js:456). Used everywhere a sauce appears in a list —
// Browse, Saucebook (via CuisineAccordion), Sauce Selector, and Sauce
// Manager — so the dot / name / variant badge / subline visual treatment
// stays identical across screens.
//
// The right side of the row is intentionally a slot: each call site passes
// whatever affordance belongs there (a "+ Saucebook" button, a missing
// badge, a chevron, a sauce-type tag, an action menu...).

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { GitBranch } from 'lucide-react-native';
import { COLORS } from '../theme';

/**
 * Props:
 *   sauce         — { name, color, authorName, createdBy, description, ... }
 *   subline       — optional override; defaults to `by ${authorName || 'SauceBoss'}`
 *   variantCount  — total versions (1 = no badge; > 1 renders the GitBranch chip)
 *   rightSlot     — ReactNode rendered before any action affordance
 *   onPress       — tap handler for the whole row
 *   onLongPress   — optional long-press handler
 *   disabled      — disables onPress + halves activeOpacity
 *   faded         — visually mute the row (used for "missing ingredients" rows)
 *   isLast        — when true, skip the bottom-border separator
 *   style         — extra style applied to the outer touchable
 */
export default function SauceRow({
  sauce,
  subline,
  variantCount,
  rightSlot,
  onPress,
  onLongPress,
  disabled,
  faded,
  isLast,
  style,
}) {
  const author = sauce.authorName || (sauce.createdBy ? 'Unknown' : 'SauceBoss');
  const computedSubline = subline != null ? subline : `by ${author}`;
  const showVariantBadge = (variantCount || 0) > 1;
  return (
    <TouchableOpacity
      style={[styles.row, !isLast && styles.rowBorder, faded && styles.rowFaded, style]}
      onPress={disabled ? null : onPress}
      onLongPress={disabled ? null : onLongPress}
      delayLongPress={350}
      activeOpacity={disabled ? 1 : 0.7}
    >
      <View style={[styles.dot, { backgroundColor: sauce.color || COLORS.primary }]} />
      <View style={styles.info}>
        <View style={styles.titleRow}>
          <Text style={[styles.name, faded && styles.nameFaded]} numberOfLines={1}>
            {sauce.name}
          </Text>
          {showVariantBadge ? (
            <View style={styles.variantBadge}>
              <GitBranch size={10} color={COLORS.textSecondary} />
              <Text style={styles.variantBadgeLabel}>{variantCount}</Text>
            </View>
          ) : null}
        </View>
        {computedSubline ? (
          <Text style={[styles.subline, faded && styles.sublineFaded]} numberOfLines={1}>
            {computedSubline}
          </Text>
        ) : null}
      </View>
      {rightSlot}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  rowFaded: { opacity: 0.45 },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    flexShrink: 1,
  },
  nameFaded: { color: COLORS.textMuted },
  variantBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceSubtle,
  },
  variantBadgeLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  subline: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  sublineFaded: {
    color: COLORS.textMuted,
  },
});
