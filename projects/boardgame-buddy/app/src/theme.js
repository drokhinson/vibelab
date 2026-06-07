// Visual tokens — ported from web/styles.css :root. Single source of truth for
// color, spacing, radii, type sizes, fonts, and RN shadow objects. Every
// component reads from here; the only legitimate inline color is a data-driven
// per-game / per-expansion accent (see gameAccent()).

export const COLORS = {
  // Brand brass/amber.
  accent: '#C9922A',
  accentHover: '#B8820E',

  // Dark "fantasy speakeasy" base (warm-tinted near-black).
  bg: '#0d0d14',
  bgElevated: '#16141d',
  card: '#1b1822',
  cardSoft: '#211d2a',
  border: '#2c2735',
  borderSoft: '#241f2d',

  // Text on dark.
  text: '#F5EFE3',
  textSoft: '#C9C2B0',
  textMuted: '#8B8275',

  // Warm spectrum accents.
  warmTaupe: '#8B7355',
  rust: '#A65D2C', // destructive
  rustText: '#E07A5F',

  // Polaroid (cream instant-photo) palette — play cards + cream screens.
  polaroidBg: '#FFFBF1',
  polaroidBgSoft: '#F5EEDC',
  polaroidInk: '#1D1812',
  polaroidInkSoft: '#4A3F2F',
  polaroidMuted: '#8B7E68',
  polaroidLine: '#DAC9A4',
  polaroidAccent: '#C8553D',

  // Status pill colors.
  owned: '#C9922A',
  wishlist: '#7a5293',
  played: '#2f6a93',

  // Misc.
  success: '#3f7d4a',
  white: '#ffffff',
  overlay: 'rgba(8,6,12,0.72)',
};

// Per-game accent. theme_color (or expansion_color) drives a game's identity
// color across every surface it appears on. Falls back to the default purple.
export function gameAccent(game) {
  if (!game) return '#6B3FA0';
  return game.theme_color || game.expansion_color || '#6B3FA0';
}

// Translucent wash of a hex color — used for tinted backgrounds behind a
// game's accent. alpha is a 0-1 float.
export function withAlpha(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const RADII = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };

export const FONT_SIZES = {
  caption: 11,
  small: 12,
  body: 14,
  heading: 16,
  title: 20,
  display: 26,
  jumbo: 34,
};

export const FONT_WEIGHTS = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

// Font family map → @expo-google-fonts names loaded in MainApp.
//   sans     = Poppins        (UI chrome, buttons, body)
//   display  = Crimson Text   (page/game/profile titles, stat values)
//   polaroid = Fraunces       (play-card captions, reference-guide body)
//   score    = JetBrains Mono (numeric scores, step counters)
export const FONTS = {
  sans: 'Poppins_400Regular',
  sansMedium: 'Poppins_500Medium',
  sansSemibold: 'Poppins_600SemiBold',
  sansBold: 'Poppins_700Bold',
  display: 'CrimsonText_600SemiBold',
  displayRegular: 'CrimsonText_400Regular',
  displayBold: 'CrimsonText_700Bold',
  polaroid: 'Fraunces_600SemiBold',
  polaroidItalic: 'Fraunces_400Regular_Italic',
  score: 'JetBrainsMono_500Medium',
  scoreBold: 'JetBrainsMono_700Bold',
};

export const SHADOWS = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.24,
    shadowRadius: 7,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.32,
    shadowRadius: 14,
    elevation: 7,
  },
  // Soft warm shadow for cream polaroid surfaces on dark backgrounds.
  polaroid: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
};

export default { COLORS, SPACING, RADII, FONT_SIZES, FONT_WEIGHTS, FONTS, SHADOWS, gameAccent, withAlpha };
