import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppActions, useAppState } from '../store/AppContext';
import { isAuthConfigured } from '../auth/supabase';
import DwpLogo from '../components/DwpLogo';
import GoogleLogo from '../components/GoogleLogo';
import ErrorBanner from '../components/ErrorBanner';
import SuccessBanner from '../components/SuccessBanner';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function AuthScreen() {
  const { authBusy, authError } = useAppState();
  const { signInWithEmail, signUpWithEmail, signInWithGoogle } = useAppActions();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState(null);
  const [localError, setLocalError] = useState(null);

  const submit = async () => {
    setInfo(null);
    setLocalError(null);
    if (!email.trim() || !password) {
      setLocalError('Email and password are required.');
      return;
    }
    const fn = mode === 'signup' ? signUpWithEmail : signInWithEmail;
    const result = await fn(email.trim(), password);
    if (!result.ok) {
      setLocalError(result.error);
      return;
    }
    if (result.message) {
      setInfo(result.message);
      setMode('login');
      setPassword('');
    }
  };

  const onGoogle = async () => {
    setInfo(null);
    setLocalError(null);
    const result = await signInWithGoogle();
    if (!result.ok && !result.cancelled) {
      setLocalError(result.error);
    }
  };

  const disabled = !isAuthConfigured || authBusy;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.logoWrap}>
            <DwpLogo size={84} />
          </View>
          <Text style={styles.title}>Day Word Play</Text>
          <Text style={styles.subtitle}>A new word every day. Your sentence. Your group's vote.</Text>

          <View style={styles.card}>
            {!isAuthConfigured ? (
              <ErrorBanner message="Sign-in is not configured for this build. Set EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_ANON_KEY in app/.env." />
            ) : null}
            <ErrorBanner message={localError || authError} />
            <SuccessBanner message={info} />

            <Pressable
              onPress={onGoogle}
              disabled={disabled}
              style={[styles.googleBtn, disabled && styles.btnDisabled]}
            >
              <GoogleLogo size={18} />
              <Text style={styles.googleText}>Continue with Google</Text>
            </Pressable>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or use email</Text>
              <View style={styles.dividerLine} />
            </View>

            <View style={styles.tabs}>
              <Pressable
                onPress={() => { setMode('login'); setLocalError(null); setInfo(null); }}
                style={[styles.tab, mode === 'login' && styles.tabActive]}
              >
                <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>Log In</Text>
              </Pressable>
              <Pressable
                onPress={() => { setMode('signup'); setLocalError(null); setInfo(null); }}
                style={[styles.tab, mode === 'signup' && styles.tabActive]}
              >
                <Text style={[styles.tabText, mode === 'signup' && styles.tabTextActive]}>Sign Up</Text>
              </Pressable>
            </View>

            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              editable={!disabled}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              placeholder="at least 6 characters"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChangeText={setPassword}
              editable={!disabled}
            />

            <Pressable
              onPress={submit}
              disabled={disabled}
              style={[styles.submit, disabled && styles.btnDisabled]}
            >
              <Text style={styles.submitText}>
                {authBusy ? '…' : mode === 'signup' ? 'Create Account' : 'Log In'}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  scroll: { padding: SPACING.lg, alignItems: 'stretch' },
  logoWrap: { alignItems: 'center', marginTop: SPACING.xl },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: COLORS.primary,
    textAlign: 'center',
    marginTop: SPACING.md,
  },
  subtitle: {
    fontSize: FONT_SIZES.body,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: SPACING.sm,
    marginBottom: SPACING.xl,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADII.xl,
    padding: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADII.lg,
    paddingVertical: SPACING.md,
    marginBottom: SPACING.md,
  },
  googleText: { fontSize: FONT_SIZES.body, fontWeight: '600', color: COLORS.text },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginVertical: SPACING.md,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.border },
  dividerText: { color: COLORS.textMuted, fontSize: FONT_SIZES.small },
  tabs: { flexDirection: 'row', marginBottom: SPACING.lg, backgroundColor: COLORS.surfaceSubtle, borderRadius: RADII.md },
  tab: { flex: 1, paddingVertical: SPACING.sm, alignItems: 'center', borderRadius: RADII.md },
  tabActive: { backgroundColor: COLORS.primary },
  tabText: { color: COLORS.textSecondary, fontWeight: '600', fontSize: FONT_SIZES.body },
  tabTextActive: { color: '#fff' },
  label: { fontSize: FONT_SIZES.small, color: COLORS.textSecondary, marginBottom: SPACING.xs, marginTop: SPACING.sm },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.body,
    color: COLORS.text,
    backgroundColor: COLORS.background,
  },
  submit: {
    backgroundColor: COLORS.primary,
    borderRadius: RADII.lg,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.lg,
  },
  submitText: { color: '#fff', fontSize: FONT_SIZES.card, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
});
