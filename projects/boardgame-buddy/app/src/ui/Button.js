// The app-wide button. Variants are parameters, never parallel implementations
// (ui-object-design). All CTAs, including destructive ones, come through here
// so press feedback, disabled state, and sizing stay identical everywhere.

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { COLORS, RADII, SPACING } from '../theme';
import Text from './Text';

const VARIANTS = {
  primary: { bg: COLORS.accent, fg: COLORS.bg, border: 'transparent' },
  secondary: { bg: COLORS.cardSoft, fg: COLORS.text, border: COLORS.border },
  ghost: { bg: 'transparent', fg: COLORS.accent, border: 'transparent' },
  outline: { bg: 'transparent', fg: COLORS.textSoft, border: COLORS.border },
  destructive: { bg: COLORS.rust, fg: COLORS.polaroidBg, border: 'transparent' },
};

const SIZES = {
  sm: { paddingVertical: 8, paddingHorizontal: SPACING.md, fontSize: 13, minHeight: 36 },
  md: { paddingVertical: 12, paddingHorizontal: SPACING.lg, fontSize: 15, minHeight: 44 },
  lg: { paddingVertical: 14, paddingHorizontal: SPACING.xl, fontSize: 16, minHeight: 50 },
};

/**
 * @param {{
 *   label?: string,
 *   onPress?: () => void,
 *   variant?: 'primary'|'secondary'|'ghost'|'outline'|'destructive',
 *   size?: 'sm'|'md'|'lg',
 *   icon?: React.ComponentType<any>,   // lucide icon
 *   disabled?: boolean,
 *   busy?: boolean,
 *   full?: boolean,                    // stretch to container width
 *   style?: any,
 * }} props
 */
export default function Button({ label, onPress, variant = 'primary', size = 'md', icon: Icon, disabled, busy, full, style }) {
  const v = VARIANTS[variant] || VARIANTS.primary;
  const s = SIZES[size] || SIZES.md;
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      hitSlop={size === 'sm' ? 6 : 0}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: v.bg,
          borderColor: v.border,
          paddingVertical: s.paddingVertical,
          paddingHorizontal: s.paddingHorizontal,
          minHeight: s.minHeight,
          alignSelf: full ? 'stretch' : 'auto',
          opacity: inactive ? 0.55 : pressed ? 0.82 : 1,
          transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={v.fg} />
      ) : (
        <>
          {Icon ? <Icon size={s.fontSize + 3} color={v.fg} /> : null}
          {label ? (
            <Text variant="button" style={{ color: v.fg, fontSize: s.fontSize }}>
              {label}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    borderRadius: RADII.md,
    borderWidth: 1,
  },
});
