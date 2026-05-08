import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { COLORS, SPACING, FONT_SIZES } from '../theme';

export default function LoadingState({ label, style }) {
  return (
    <View style={[styles.wrap, style]}>
      <ActivityIndicator size="small" color={COLORS.primary} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACING.xl, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  label: { color: COLORS.textMuted, fontSize: FONT_SIZES.body },
});
