// Visual tokens. Pulls palette + spacing + radii from #shared/themeTokens so web
// and native stay aligned, and adds RN-specific shadow objects.

import { COLORS as SHARED_COLORS, SPACING, RADII, FONT_SIZES, FONT_WEIGHTS } from '#shared/themeTokens';

export const COLORS = SHARED_COLORS;
export { SPACING, RADII, FONT_SIZES, FONT_WEIGHTS };

export const SHADOWS = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.13,
    shadowRadius: 12,
    elevation: 6,
  },
  primary: {
    shadowColor: SHARED_COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 14,
    elevation: 6,
  },
};

export const FONTS = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extrabold: 'Inter_800ExtraBold',
};
