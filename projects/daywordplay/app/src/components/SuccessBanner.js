import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { COLORS, RADII, SPACING, FONT_SIZES } from '../theme';

export default function SuccessBanner({ message, style }) {
  if (!message) return null;
  return (
    <View style={[styles.wrap, style]}>
      <Text style={styles.text}>{String(message)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.success,
    borderRadius: RADII.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
  },
  text: { color: COLORS.successText, fontSize: FONT_SIZES.body, lineHeight: 20 },
});
