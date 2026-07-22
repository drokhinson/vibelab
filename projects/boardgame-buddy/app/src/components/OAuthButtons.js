// src/components/OAuthButtons.js — OAuth sign-in buttons. Follows
// .claude/rules/auth-ui.md: full-width pill, official 4-color Google "G" mark,
// "Continue with Google" label. Apple Sign-In is deferred.

import React from 'react';
import {
  TouchableOpacity, Text, ActivityIndicator, StyleSheet,
} from 'react-native';
import { SvgXml } from 'react-native-svg';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII } from '../theme';

// Official Google "G" — four <path> elements with brand fills.
const GOOGLE_G = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<path fill="#4285F4" d="M23.06 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.38Z"/>
<path fill="#34A853" d="M12 23.5c3.1 0 5.7-1.03 7.6-2.78l-3.72-2.89c-1.03.69-2.35 1.1-3.88 1.1-2.98 0-5.5-2.01-6.4-4.72H1.76v2.98A11.5 11.5 0 0 0 12 23.5Z"/>
<path fill="#FBBC05" d="M5.6 14.21a6.9 6.9 0 0 1 0-4.42V6.81H1.76a11.5 11.5 0 0 0 0 10.38l3.84-2.98Z"/>
<path fill="#EA4335" d="M12 4.75c1.68 0 3.2.58 4.39 1.72l3.29-3.29C17.7 1.3 15.1.25 12 .25A11.5 11.5 0 0 0 1.76 6.81l3.84 2.98C6.5 6.76 9.02 4.75 12 4.75Z"/>
</svg>`;

export default function OAuthButtons({ onGoogle, busy, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.btn, disabled && styles.disabled]}
      onPress={onGoogle}
      disabled={disabled || busy}
      activeOpacity={0.85}
    >
      {busy ? (
        <ActivityIndicator color={COLORS.text} />
      ) : (
        <>
          <SvgXml xml={GOOGLE_G} width={20} height={20} />
          <Text style={styles.label}>Continue with Google</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    width: '100%',
    minHeight: 50,
    backgroundColor: COLORS.white,
    borderWidth: 1.5,
    borderColor: COLORS.borderStrong,
    borderRadius: RADII.pill,
    paddingHorizontal: SPACING.lg,
  },
  disabled: { opacity: 0.6 },
  label: {
    fontFamily: FONTS.semibold,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
  },
});
