// Sticky footer for primary CTAs. Rendered inside Screen's
// KeyboardAvoidingView so it rides up with the keyboard instead of being
// covered — the one place Continue/Save/Join buttons live on entry screens.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS, SPACING } from '../theme';

export default function FooterBar({ bottomInset = 0, children }) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottomInset, SPACING.md) }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSoft,
    backgroundColor: COLORS.bgElevated,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
});
