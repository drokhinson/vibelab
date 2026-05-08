import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { COLORS, RADII, SPACING, FONT_SIZES } from '../theme';

export default function ErrorBanner({ message, style }) {
  if (!message) return null;
  return (
    <View style={[styles.wrap, style]}>
      <Text style={styles.text}>{String(message)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.danger,
    borderRadius: RADII.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  text: { color: COLORS.dangerText, fontSize: FONT_SIZES.body, lineHeight: 20 },
});
