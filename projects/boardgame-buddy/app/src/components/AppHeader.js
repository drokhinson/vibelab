// AppHeader — consistent top bar for stack screens: back chevron, title in
// Crimson, optional right action slot.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { COLORS, FONTS, SPACING } from '../theme';

export default function AppHeader({ title, onBack, right, subtitle }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top + 6 }]}>
      <View style={styles.side}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
            <ChevronLeft size={26} color={COLORS.text} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.center}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    backgroundColor: COLORS.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  side: { width: 64, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center' },
  title: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 20 },
  subtitle: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 12 },
});
