import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function GroupSwitcher() {
  const { myGroups, activeGroupId } = useAppState();
  const { setActiveGroup, loadToday } = useAppActions();

  if (myGroups.length <= 1) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {myGroups.map((g) => {
        const active = g.id === activeGroupId;
        return (
          <Pressable
            key={g.id}
            onPress={() => {
              setActiveGroup(g.id);
              loadToday(g.id).catch(() => {});
            }}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
              {g.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, gap: SPACING.sm },
  chip: {
    backgroundColor: COLORS.surface,
    borderRadius: RADII.pill,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { fontSize: FONT_SIZES.body, color: COLORS.textSecondary, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
});
