// Full-surface loading placeholder — boot gate and screen-level waits. List
// screens should prefer inline <Skeleton> rows in their real layout; this is
// for surfaces that have nothing to shape yet.

import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { COLORS, SPACING } from '../theme';
import { Text } from '../ui';

export default function LoadingState({ label = 'Loading…' }) {
  return (
    <View style={{ alignItems: 'center', gap: SPACING.md, padding: SPACING.xl }}>
      <ActivityIndicator size="large" color={COLORS.accent} />
      <Text variant="small" center>
        {label}
      </Text>
    </View>
  );
}
