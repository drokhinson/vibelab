// LoadingState — the one branded loader used on every screen while data loads.

import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS, FONTS, SPACING } from '../theme';

export default function LoadingState({ label = 'Loading…', style }) {
  return (
    <View style={[styles.wrap, style]}>
      <ActivityIndicator size="large" color={COLORS.accent} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  label: { fontFamily: FONTS.display, color: COLORS.textSoft, fontSize: 16, marginTop: SPACING.md },
});
