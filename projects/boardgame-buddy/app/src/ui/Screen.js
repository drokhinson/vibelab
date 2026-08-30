// Screen wrapper — the uncluttered-UX guarantee lives here. Every screen gets:
//   • safe-area padding
//   • a scrollable body (or a bare flex body for screens that own a FlatList)
//   • an optional footer slot rendered through FooterBar, which
//     KeyboardAvoidingView keeps ABOVE the keyboard at all times, so primary
//     CTAs (Continue / Save / Join) are never covered by typing.

import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, SPACING } from '../theme';
import FooterBar from './FooterBar';

/**
 * @param {{
 *   scroll?: boolean,          // wrap children in a keyboard-friendly ScrollView
 *   pad?: boolean,             // horizontal body padding (default true)
 *   footer?: any,              // FooterBar contents; kept above the keyboard
 *   header?: any,              // fixed header (AppHeader) above the body
 *   edges?: { top?: boolean, bottom?: boolean },
 *   style?: any,
 *   children?: any,
 * }} props
 */
export default function Screen({ scroll = false, pad = true, footer, header, edges = { top: true, bottom: true }, style, children }) {
  const insets = useSafeAreaInsets();
  const body = scroll ? (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[pad && { paddingHorizontal: SPACING.lg }, { paddingBottom: SPACING.xxl }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, pad && { paddingHorizontal: SPACING.lg }]}>{children}</View>
  );

  return (
    <View style={[{ flex: 1, backgroundColor: COLORS.bg, paddingTop: edges.top ? insets.top : 0 }, style]}>
      {header || null}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {body}
        {footer ? <FooterBar bottomInset={edges.bottom ? insets.bottom : 0}>{footer}</FooterBar> : null}
      </KeyboardAvoidingView>
    </View>
  );
}
