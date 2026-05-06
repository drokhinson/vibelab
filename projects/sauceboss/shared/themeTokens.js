// Single source of truth for visual tokens. Native imports this directly.
// Web (future refactor) can map these to CSS variables.

export const COLORS = {
  primary: '#E85D04',
  primaryDark: '#C44B00',
  primaryLight: '#F48C06',
  accent: '#FAA307',
  background: '#FFF8F0',
  card: '#FFFFFF',
  text: '#1A1A2E',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',
  border: '#E5E7EB',
  borderStrong: '#D1D5DB',
  surfaceSubtle: '#F3F4F6',
  success: '#D1FAE5',
  successText: '#065F46',
  danger: '#FEE2E2',
  dangerText: '#991B1B',
  warning: '#FEF3CD',
  warningText: '#78350F',
  info: '#EFF6FF',
  infoText: '#0369A1',
  available: '#F0FDF4',
  unavailable: '#F9FAFB',
  highlightTint: '#FFF3E0',
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
  md: 10,
  lg: 14,
  xl: 18,
  pill: 999,
};

export const FONT_SIZES = {
  caption: 11,
  small: 12,
  body: 14,
  card: 16,
  section: 18,
  title: 22,
  logo: 26,
};

export const FONT_WEIGHTS = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};
