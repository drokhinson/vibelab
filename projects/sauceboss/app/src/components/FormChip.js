// Pressable pill for tabs and category filters. Matches web's .cat-tab + .chip.

import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { COLORS, RADII } from '../theme';

export default function FormChip({
  label,
  active = false,
  onPress,
  icon = null,
  variant = 'tab', // 'tab' | 'pill'
  disabled = false,
  style,
  testID,
}) {
  const isTab = variant === 'tab';
  return (
    <TouchableOpacity
      style={[
        styles.base,
        isTab ? styles.tab : styles.pill,
        active && (isTab ? styles.tabActive : styles.pillActive),
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      testID={testID}
    >
      {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
      <Text
        style={[
          isTab ? styles.tabLabel : styles.pillLabel,
          active && (isTab ? styles.tabLabelActive : styles.pillLabelActive),
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Tab variant — the home Carbs/Proteins/Salads bar
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: COLORS.primary,
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginLeft: 6,
  },
  tabLabelActive: {
    color: COLORS.primary,
  },
  // Pill variant — used in filters and small toggles
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    marginRight: 6,
    marginBottom: 6,
  },
  pillActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  pillLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  pillLabelActive: {
    color: '#fff',
  },
  iconWrap: {
    marginRight: 4,
  },
  disabled: {
    opacity: 0.5,
  },
});
