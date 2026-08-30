// EmptyState — the one empty/error placeholder. Icon + message + optional CTA.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Dice5 } from 'lucide-react-native';
import { COLORS, SPACING } from '../theme';
import { Button, Text } from '../ui';

export default function EmptyState({ icon: Icon = Dice5, title, body, ctaLabel, onCta, tone = 'muted', style }) {
  return (
    <View style={[styles.wrap, style]}>
      <Icon size={48} color={tone === 'error' ? COLORS.rustText : COLORS.textMuted} />
      {title ? (
        <Text variant="title" center>
          {title}
        </Text>
      ) : null}
      {body ? (
        <Text variant="small" center style={{ lineHeight: 20 }}>
          {body}
        </Text>
      ) : null}
      {ctaLabel && onCta ? <Button label={ctaLabel} onPress={onCta} size="sm" style={{ marginTop: SPACING.md }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl, gap: SPACING.sm },
});
