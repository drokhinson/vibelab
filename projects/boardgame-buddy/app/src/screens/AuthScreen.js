// AuthScreen — Supabase email/password sign-in/up + Google OAuth (auth-ui
// standard). Closes itself once a session lands.

import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { X } from 'lucide-react-native';
import { COLORS, SPACING } from '../theme';
import { Button, Card, Input, Screen, Stack, Text } from '../ui';
import { useAppActions, useAppState } from '../store/AppContext';
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
  }, [state.currentUser, navigation]);

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
    <Screen scroll>
      <Pressable
        onPress={() => navigation.goBack()}
        hitSlop={12}
        style={{ alignSelf: 'flex-end', padding: SPACING.sm, marginTop: SPACING.sm }}
      >
        <X size={24} color={COLORS.textSoft} />
      </Pressable>

      <View style={{ marginTop: SPACING.xl, marginBottom: SPACING.xl }}>
        <Text variant="display" center color={COLORS.accent}>
          Boardgame Buddy
        </Text>
        <Text variant="small" center style={{ marginTop: SPACING.sm }}>
          Log your plays. Track your shelf. Find your people.
        </Text>
      </View>

      <Card>
        <Stack gap="sm">
          <OAuthButtons onGoogle={actions.signInGoogle} disabled={state.authBusy} />

          <Input
            placeholder="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Input placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />

          {notice || state.authError ? (
            <Text variant="small" color={COLORS.rustText}>
              {notice || state.authError}
            </Text>
          ) : null}

          <Button
            label={mode === 'signin' ? 'Sign in' : 'Create account'}
            onPress={submit}
            busy={state.authBusy}
            full
            style={{ marginTop: SPACING.sm }}
          />

          <Pressable
            onPress={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setNotice('');
            }}
            hitSlop={8}
            style={{ paddingVertical: SPACING.sm }}
          >
            <Text variant="bodyMedium" center color={COLORS.accent}>
              {mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}
            </Text>
          </Pressable>
        </Stack>
      </Card>
    </Screen>
  );
}
