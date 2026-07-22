// src/components/AppHeader.js — shared in-screen header: the BoardgameBuddy
// wordmark (or a screen title) on the left, an optional right slot (e.g. the
// user badge that opens Settings). Sits under the safe-area inset.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONTS, FONT_SIZES, SPACING } from '../theme';

export default function AppHeader({ title = 'BoardgameBuddy', right, subtitle }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + SPACING.sm }]}>
      <View style={styles.row}>
        <View style={styles.titleCol}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
  },
  titleCol: { flex: 1, paddingRight: SPACING.md },
  title: {
    fontFamily: FONTS.displayBold,
    fontSize: FONT_SIZES.xxl,
    color: COLORS.text,
  },
  subtitle: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  right: { marginLeft: SPACING.sm },
});
