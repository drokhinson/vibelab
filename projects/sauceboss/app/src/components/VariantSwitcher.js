// Chip row above a recipe to switch between sibling variants. Mirrors web .variant-switcher.

import React from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { COLORS } from '../theme';

export default function VariantSwitcher({ family, currentId, onSelect }) {
  if (!family || family.length <= 1) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.wrap}>
      {family.map((s) => {
        const active = s.id === currentId;
        return (
          <TouchableOpacity
            key={s.id}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onSelect(s)}
            activeOpacity={0.8}
          >
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {s.name}
            </Text>
            {!s.parentSauceId ? (
              <View style={styles.tag}>
                <Text style={styles.tagText}>original</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingVertical: 4,
    paddingRight: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.card,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    marginRight: 6,
    maxWidth: 220,
  },
  chipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
    flexShrink: 1,
  },
  labelActive: {
    color: '#fff',
  },
  tag: {
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  tagText: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 0.5,
  },
});
