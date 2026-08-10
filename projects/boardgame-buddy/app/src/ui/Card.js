// Surface container. Two families: the default dark elevated card, and the
// cream "polaroid" surface used for play cards and parchment content.

import React from 'react';
import { Pressable, View } from 'react-native';
import { COLORS, RADII, SHADOWS, SPACING } from '../theme';

const VARIANTS = {
  base: { backgroundColor: COLORS.card, borderColor: COLORS.border, shadow: SHADOWS.sm },
  soft: { backgroundColor: COLORS.cardSoft, borderColor: COLORS.borderSoft, shadow: null },
  polaroid: { backgroundColor: COLORS.polaroidBg, borderColor: COLORS.polaroidLine, shadow: SHADOWS.polaroid },
};

/**
 * @param {{
 *   variant?: 'base'|'soft'|'polaroid',
 *   onPress?: () => void,
 *   pad?: keyof typeof SPACING | number | false,
 *   style?: any,
 *   children?: any,
 * }} props
 */
export default function Card({ variant = 'base', onPress, pad = 'lg', style, children }) {
  const v = VARIANTS[variant] || VARIANTS.base;
  const padding = pad === false ? 0 : typeof pad === 'number' ? pad : SPACING[pad] ?? SPACING.lg;
  const body = (
    <View
      style={[
        {
          backgroundColor: v.backgroundColor,
          borderColor: v.borderColor,
          borderWidth: 1,
          borderRadius: RADII.lg,
          padding,
          overflow: 'visible',
        },
        v.shadow,
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}>
      {body}
    </Pressable>
  );
}
