// src/screens/AuthScreen.js — sign in / sign up. Email + password plus Google
// OAuth (via the web bridge). Shown by MainApp whenever there's no session.

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppState, useAppActions } from '../store/AppContext';
import OAuthButtons from '../components/OAuthButtons';
import UserBadge from '../components/UserBadge';
import { COLORS, FONTS, FONT_SIZES, SPACING, RADII } from '../theme';

export default function AuthScreen() {
  const { authBusy, authError } = useAppState();
  const actions = useAppActions();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState(null);
  const [localError, setLocalError] = useState(null);

  const isSignup = mode === 'signup';
  const error = localError || authError;

  async function submit() {
    setLocalError(null);
    setNotice(null);
    if (!email.trim() || !password) {
      setLocalError('Enter your email and password.');
      return;
    }
    if (isSignup && password.length < 6) {
      setLocalError('Password must be at least 6 characters.');
      return;
    }
    const res = isSignup
      ? await actions.signUpEmail(email, password)
      : await actions.signInEmail(email, password);
    if (res.ok && res.needsConfirm) {
      setNotice('Check your email to confirm your account, then sign in.');
      setMode('signin');
    }
  }

  function switchMode(next) {
    actions.clearAuthError();
    setLocalError(null);
    setNotice(null);
    setMode(next);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + SPACING.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <UserBadge avatar={{ icon: 'die', iconColor: '#C9922A', bgColor: '#2a1812' }} size="lg" />
          <Text style={styles.wordmark}>BoardgameBuddy</Text>
          <Text style={styles.tagline}>Track plays. Build your shelf. Play together.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.heading}>{isSignup ? 'Create your account' : 'Welcome back'}</Text>

          <OAuthButtons onGoogle={() => actions.signInGoogle()} busy={authBusy} disabled={authBusy} />

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>or use email</Text>
            <View style={styles.divider} />
          </View>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={COLORS.textMuted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={COLORS.textMuted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType={isSignup ? 'newPassword' : 'password'}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          <TouchableOpacity
            style={[styles.submit, authBusy && styles.submitDisabled]}
            onPress={submit}
            disabled={authBusy}
            activeOpacity={0.85}
          >
            {authBusy ? (
              <ActivityIndicator color={COLORS.brown} />
            ) : (
              <Text style={styles.submitText}>{isSignup ? 'Sign up' : 'Sign in'}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.switch}
            onPress={() => switchMode(isSignup ? 'signin' : 'signup')}
          >
            <Text style={styles.switchText}>
              {isSignup ? 'Already have an account? Sign in' : "New here? Create an account"}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xxl,
  },
  brand: { alignItems: 'center', marginBottom: SPACING.xl },
  wordmark: {
    fontFamily: FONTS.displayBold,
    fontSize: FONT_SIZES.display,
    color: COLORS.text,
    marginTop: SPACING.md,
  },
  tagline: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
    textAlign: 'center',
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    padding: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  heading: {
    fontFamily: FONTS.display,
    fontSize: FONT_SIZES.xl,
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.lg,
    gap: SPACING.sm,
  },
  divider: { flex: 1, height: 1, backgroundColor: COLORS.border },
  dividerText: {
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.xs,
    color: COLORS.textMuted,
  },
  input: {
    backgroundColor: COLORS.background,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    minHeight: 50,
    fontFamily: FONTS.regular,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    marginBottom: SPACING.md,
  },
  error: {
    fontFamily: FONTS.medium,
    fontSize: FONT_SIZES.sm,
    color: COLORS.danger,
    marginBottom: SPACING.sm,
  },
  notice: {
    fontFamily: FONTS.medium,
    fontSize: FONT_SIZES.sm,
    color: COLORS.owned,
    marginBottom: SPACING.sm,
  },
  submit: {
    backgroundColor: COLORS.accent,
    minHeight: 52,
    borderRadius: RADII.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
  },
  submitDisabled: { opacity: 0.7 },
  submitText: {
    fontFamily: FONTS.bold,
    fontSize: FONT_SIZES.lg,
    color: COLORS.brown,
  },
  switch: { alignItems: 'center', marginTop: SPACING.lg, padding: SPACING.sm },
  switchText: {
    fontFamily: FONTS.medium,
    fontSize: FONT_SIZES.sm,
    color: COLORS.accentHover,
  },
});
