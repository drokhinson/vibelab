// AuthScreen — Supabase email/password sign-in/up + Google OAuth. Mirrors
// web/views/auth-view.js. Apple deferred. Closes itself once a session lands
// (AppContext flips currentUser → the auth-gated screen the user wanted shows).

import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import { useAppState, useAppActions } from '../store/AppContext';
import OAuthButtons from '../components/OAuthButtons';

export default function AuthScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');

  // Once signed in, dismiss the auth modal.
  useEffect(() => {
    if (state.currentUser) navigation.goBack();
  }, [state.currentUser]);

  async function submit() {
    setNotice('');
    if (!email.trim() || !password) {
      setNotice('Enter your email and password.');
      return;
    }
    const r = mode === 'signin'
      ? await actions.signInEmail(email.trim(), password)
      : await actions.signUpEmail(email.trim(), password);
    if (r.ok && r.needsConfirm) setNotice('Check your email to confirm your account, then sign in.');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable style={styles.close} onPress={() => navigation.goBack()} hitSlop={10}>
            <X size={24} color={COLORS.textSoft} />
          </Pressable>

          <Text style={styles.brand}>Boardgame Buddy</Text>
          <Text style={styles.tagline}>Log your plays. Track your shelf. Find your people.</Text>

          <View style={styles.card}>
            <OAuthButtons onGoogle={actions.signInGoogle} disabled={state.authBusy} />

            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            {(notice || state.authError) ? (
              <Text style={styles.error}>{notice || state.authError}</Text>
            ) : null}

            <Pressable style={[styles.primary, state.authBusy && styles.disabled]} onPress={submit} disabled={state.authBusy}>
              <Text style={styles.primaryLabel}>{mode === 'signin' ? 'Sign in' : 'Create account'}</Text>
            </Pressable>

            <Pressable onPress={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setNotice(''); }}>
              <Text style={styles.switch}>
                {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  scroll: { padding: SPACING.xl, paddingTop: SPACING.xxl, flexGrow: 1, justifyContent: 'center' },
  close: { position: 'absolute', top: SPACING.md, right: SPACING.md, padding: 8 },
  brand: { fontFamily: FONTS.displayBold, color: COLORS.accent, fontSize: 32, textAlign: 'center' },
  tagline: { fontFamily: FONTS.sans, color: COLORS.textSoft, fontSize: 14, textAlign: 'center', marginTop: SPACING.sm, marginBottom: SPACING.xl },
  card: { backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.border },
  input: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    color: COLORS.text,
    fontFamily: FONTS.sans,
    fontSize: 15,
    marginTop: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  error: { fontFamily: FONTS.sans, color: COLORS.rustText, fontSize: 13, marginTop: SPACING.sm },
  primary: { backgroundColor: COLORS.accent, borderRadius: RADII.md, paddingVertical: 13, alignItems: 'center', marginTop: SPACING.lg },
  disabled: { opacity: 0.6 },
  primaryLabel: { fontFamily: FONTS.sansBold, color: COLORS.bg, fontSize: 16 },
  switch: { fontFamily: FONTS.sansMedium, color: COLORS.accent, fontSize: 13, textAlign: 'center', marginTop: SPACING.lg },
});
