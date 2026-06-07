// EmptyState — the one empty/error placeholder. Icon + message + optional CTA.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Dice5 } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';

export default function EmptyState({ icon: Icon = Dice5, title, body, ctaLabel, onCta, tone = 'muted', style }) {
  return (
    <View style={[styles.wrap, style]}>
      <Icon size={48} color={tone === 'error' ? COLORS.rustText : COLORS.textMuted} />
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {ctaLabel && onCta ? (
        <Pressable style={styles.cta} onPress={onCta}>
          <Text style={styles.ctaLabel}>{ctaLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl, gap: SPACING.sm },
  title: { fontFamily: FONTS.display, color: COLORS.text, fontSize: 20, textAlign: 'center' },
  body: { fontFamily: FONTS.sans, color: COLORS.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cta: { marginTop: SPACING.md, backgroundColor: COLORS.accent, paddingHorizontal: SPACING.xl, paddingVertical: 10, borderRadius: RADII.pill },
  ctaLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 14 },
});
