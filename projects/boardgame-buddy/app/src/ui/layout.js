// Layout helpers — Row / Stack / Spacer. Gap-first flex wrappers so screens
// compose spacing from tokens instead of sprinkling margins.

import React from 'react';
import { View } from 'react-native';
import { SPACING } from '../theme';

/** Horizontal flex row. gap is a SPACING key or number. */
export function Row({ gap = 'sm', align = 'center', justify = 'flex-start', wrap = false, style, children, ...rest }) {
  return (
    <View
      {...rest}
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: justify,
          gap: typeof gap === 'number' ? gap : SPACING[gap] ?? SPACING.sm,
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Vertical stack. gap is a SPACING key or number. */
export function Stack({ gap = 'sm', align = 'stretch', style, children, ...rest }) {
  return (
    <View
      {...rest}
      style={[
        { flexDirection: 'column', alignItems: align, gap: typeof gap === 'number' ? gap : SPACING[gap] ?? SPACING.sm },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Fixed-size flexible gap. */
export function Spacer({ size = 'lg', flex }) {
  if (flex) return <View style={{ flex: 1 }} />;
  const px = typeof size === 'number' ? size : SPACING[size] ?? SPACING.lg;
  return <View style={{ width: px, height: px }} />;
}
