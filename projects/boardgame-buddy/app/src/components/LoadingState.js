// src/components/LoadingState.js — shared loading placeholder. One surface so
// every screen's "fetching…" state reads the same.

import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS, FONTS, FONT_SIZES, SPACING } from '../theme';

export default function LoadingState({ label, style }) {
  return (
    <View style={[styles.wrap, style]}>
      <ActivityIndicator size="large" color={COLORS.accent} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  label: {
    marginTop: SPACING.md,
    color: COLORS.textSecondary,
    fontFamily: FONTS.medium,
    fontSize: FONT_SIZES.sm,
  },
});
