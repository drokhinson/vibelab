// src/theme.js — BoardgameBuddy design tokens for the native app.
//
// Ported from the web prototype's CSS custom properties (web/styles.css :root)
// so the two clients read as the same product: warm parchment surfaces, a gold
// accent, a serif display face (Crimson Text) over a sans body (Poppins), and a
// rust destructive accent.

export const COLORS = {
  // Brand
  accent: '#C9922A', // gold — primary actions, active states
  accentHover: '#B8820E',
  brown: '#2a1812', // deep board-wood — splash, default badge bg
  danger: '#A65D2C', // rust — destructive actions

  // Surfaces (parchment family)
  background: '#F5EEDC', // soft parchment — app background
  card: '#FFFBF1', // polaroid-bg — cards, sheets
  cardSoft: '#F5EEDC',

  // Ink
  text: '#1D1812', // polaroid-ink
  textSecondary: '#4A3F2F', // polaroid-ink-soft
  textMuted: '#8A7E6B',

  // Lines
  border: '#E4D8BE',
  borderStrong: '#D2C29A',

  // Status badge colors (collection status)
  owned: '#2a8a7a', // teal
  wishlist: '#C9922A', // gold
  played: '#7a5293', // purple

  // Misc
  white: '#FFFFFF',
  overlay: 'rgba(29, 24, 18, 0.55)',
  ghost: '#C9C2B0', // free-text seat badge bg
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const RADII = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
};

export const FONT_SIZES = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 22,
  xxl: 28,
  display: 34,
};

// Loaded via @expo-google-fonts in MainApp. Sans = Poppins (body/UI),
// display = Crimson Text (headers, the project's serif voice).
export const FONTS = {
  regular: 'Poppins_400Regular',
  medium: 'Poppins_500Medium',
  semibold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
  display: 'CrimsonText_600SemiBold',
  displayBold: 'CrimsonText_700Bold',
};

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
};
