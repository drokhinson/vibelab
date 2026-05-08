// Re-exports shared visual tokens + adds native-only extras (shadows).

export { COLORS, SPACING, RADII, FONT_SIZES, FONT_WEIGHTS } from '#shared/themeTokens';

export const SHADOWS = {
  sm: {
    shadowColor: '#1A1A1A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  md: {
    shadowColor: '#1A1A1A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
};
