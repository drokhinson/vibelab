// Email + password sign-in / sign-up. Phase 2 only — Google + Apple OAuth
// will be added in v1.1 along with the EAS build pipeline (the OAuth scheme
// requires a custom redirect URL that Expo Go can't serve).

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import { isAuthConfigured } from '../auth/supabase';
import { COLORS, SHADOWS } from '../theme';

export default function AuthModal({ visible, onClose }) {
  const state = useAppState();
  const actions = useAppActions();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signupNotice, setSignupNotice] = useState(null);

  function reset() {
    setEmail('');
    setPassword('');
    setSignupNotice(null);
    actions.clearAuthError();
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit() {
    if (!email.trim() || !password) {
      return;
    }
    if (mode === 'login') {
      const { ok } = await actions.signIn(email.trim(), password);
      if (ok) handleClose();
    } else {
      const { ok, needsConfirmation } = await actions.signUp(email.trim(), password);
      if (ok && !needsConfirmation) {
        // Email confirmation is OFF in Supabase — Supabase already signed
        // them in. Close the modal and let onAuthStateChange wire the rest.
        handleClose();
      } else if (ok && needsConfirmation) {
        setSignupNotice(
          "Account created. Click the link in your email to confirm, then sign in. " +
            "If no email arrives within a minute, ask the app owner to disable email confirmation in Supabase Auth settings.",
        );
      }
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      {/* Backdrop tap closes the modal — onRequestClose only fires on Android
          back-button. TouchableWithoutFeedback on the card swallows taps so
          we don't dismiss when the user is interacting with the form. */}
      <TouchableWithoutFeedback onPress={handleClose}>
        <View style={styles.backdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.kav}
          >
            <ScrollView
              contentContainerStyle={styles.scroll}
              keyboardShouldPersistTaps="handled"
            >
              <TouchableWithoutFeedback>
                <View style={styles.card}>
              <View style={styles.headerRow}>
                <Text style={styles.title}>
                  {mode === 'login' ? 'Sign in' : 'Create account'}
                </Text>
                <TouchableOpacity onPress={handleClose} hitSlop={12}>
                  <X size={20} color={COLORS.textSecondary} />
                </TouchableOpacity>
              </View>

              {!isAuthConfigured ? (
                <Text style={styles.notice}>
                  Sign-in isn't configured for this build. Add EXPO_PUBLIC_SUPABASE_URL
                  and EXPO_PUBLIC_SUPABASE_ANON_KEY to app/.env and reload.
                </Text>
              ) : (
                <>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    value={email}
                    onChangeText={(v) => { setEmail(v); actions.clearAuthError(); }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    placeholder="you@example.com"
                    placeholderTextColor={COLORS.textMuted}
                    style={styles.input}
                  />

                  <Text style={styles.label}>Password</Text>
                  <TextInput
                    value={password}
                    onChangeText={(v) => { setPassword(v); actions.clearAuthError(); }}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType={mode === 'login' ? 'password' : 'newPassword'}
                    placeholder="••••••••"
                    placeholderTextColor={COLORS.textMuted}
                    style={styles.input}
                  />

                  {state.authError ? (
                    <Text style={styles.error}>{state.authError}</Text>
                  ) : null}
                  {signupNotice ? (
                    <Text style={styles.success}>{signupNotice}</Text>
                  ) : null}

                  <TouchableOpacity
                    style={[
                      styles.submit,
                      (!email.trim() || !password || state.authBusy) && styles.submitDisabled,
                    ]}
                    onPress={handleSubmit}
                    disabled={!email.trim() || !password || state.authBusy}
                    activeOpacity={0.8}
                  >
                    {state.authBusy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.submitLabel}>
                        {mode === 'login' ? 'Sign in' : 'Create account'}
                      </Text>
                    )}
                  </TouchableOpacity>

                  <View style={styles.dividerRow}>
                    <View style={styles.dividerLine} />
                    <Text style={styles.dividerLabel}>or</Text>
                    <View style={styles.dividerLine} />
                  </View>

                  <TouchableOpacity
                    style={[styles.googleBtn, state.authBusy && styles.submitDisabled]}
                    onPress={async () => {
                      const res = await actions.signInWithGoogle();
                      if (res.ok) handleClose();
                    }}
                    disabled={state.authBusy}
                    activeOpacity={0.85}
                  >
                    <View style={styles.googleIcon}>
                      <Text style={styles.googleIconLabel}>G</Text>
                    </View>
                    <Text style={styles.googleLabel}>Continue with Google</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => {
                      setMode((m) => (m === 'login' ? 'signup' : 'login'));
                      setSignupNotice(null);
                      actions.clearAuthError();
                    }}
                    style={styles.toggle}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.toggleText}>
                      {mode === 'login'
                        ? "New here? Create an account"
                        : 'Already have one? Sign in'}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
                </View>
              </TouchableWithoutFeedback>
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  kav: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 22,
    ...SHADOWS.lg,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.text,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.text,
  },
  error: {
    color: COLORS.dangerText,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 10,
    backgroundColor: COLORS.danger,
    padding: 10,
    borderRadius: 8,
  },
  success: {
    color: COLORS.successText,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 10,
    backgroundColor: COLORS.success,
    padding: 10,
    borderRadius: 8,
  },
  notice: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    paddingVertical: 8,
  },
  submit: {
    marginTop: 16,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  dividerLabel: {
    marginHorizontal: 10,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textMuted,
    letterSpacing: 0.5,
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingVertical: 11,
  },
  googleIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#4285F4',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  googleIconLabel: {
    fontSize: 13,
    fontWeight: '900',
    color: '#4285F4',
  },
  googleLabel: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },
  toggle: {
    marginTop: 12,
    alignItems: 'center',
  },
  toggleText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '600',
  },
});
