// Semantic text. Screens never use raw <Text> — every string picks a variant
// so typography stays on the four-family system (Poppins UI / Crimson display /
// Fraunces polaroid / JetBrains score) app-wide.

import React from 'react';
import { Text as RNText } from 'react-native';
import { COLORS, FONTS, FONT_SIZES } from '../theme';

const VARIANTS = {
  // Poppins — UI chrome.
  body: { fontFamily: FONTS.sans, fontSize: FONT_SIZES.body, color: COLORS.text },
  bodyMedium: { fontFamily: FONTS.sansMedium, fontSize: FONT_SIZES.body, color: COLORS.text },
  small: { fontFamily: FONTS.sans, fontSize: FONT_SIZES.small, color: COLORS.textSoft },
  caption: { fontFamily: FONTS.sansMedium, fontSize: FONT_SIZES.caption, color: COLORS.textMuted },
  label: { fontFamily: FONTS.sansSemibold, fontSize: FONT_SIZES.small, color: COLORS.textSoft, letterSpacing: 0.6, textTransform: 'uppercase' },
  button: { fontFamily: FONTS.sansBold, fontSize: FONT_SIZES.heading, color: COLORS.bg },

  // Crimson Text — page/section/object titles and stat values.
  title: { fontFamily: FONTS.displayBold, fontSize: FONT_SIZES.title, color: COLORS.text },
  heading: { fontFamily: FONTS.display, fontSize: FONT_SIZES.heading, color: COLORS.text },
  display: { fontFamily: FONTS.displayBold, fontSize: FONT_SIZES.display, color: COLORS.text },
  statValue: { fontFamily: FONTS.displayBold, fontSize: FONT_SIZES.title, color: COLORS.accent },

  // Fraunces — polaroid captions and reference-guide prose (cream surfaces).
  polaroid: { fontFamily: FONTS.polaroid, fontSize: FONT_SIZES.body, color: COLORS.polaroidInk },
  polaroidItalic: { fontFamily: FONTS.polaroidItalic, fontSize: FONT_SIZES.small, color: COLORS.polaroidInkSoft, fontStyle: 'italic' },

  // JetBrains Mono — scores, codes, step counters.
  score: { fontFamily: FONTS.score, fontSize: FONT_SIZES.body, color: COLORS.text },
  scoreBig: { fontFamily: FONTS.scoreBold, fontSize: FONT_SIZES.title, color: COLORS.text },
};

/**
 * @param {{
 *   variant?: keyof typeof VARIANTS,
 *   color?: string,
 *   center?: boolean,
 *   style?: any,
 * } & import('react-native').TextProps} props
 */
export default function Text({ variant = 'body', color, center, style, ...rest }) {
  const base = VARIANTS[variant] || VARIANTS.body;
  return (
    <RNText
      {...rest}
      style={[base, color ? { color } : null, center ? { textAlign: 'center' } : null, style]}
    />
  );
}
