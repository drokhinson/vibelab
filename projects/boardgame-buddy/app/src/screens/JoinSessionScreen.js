// JoinSessionScreen — type the host's 5-letter code. The Join CTA sits in the
// FooterBar so the keyboard never covers it.

import React, { useState } from 'react';
import { Ticket } from 'lucide-react-native';
import { COLORS, FONTS, SPACING } from '../theme';
import { Button, Input, Screen, Stack, Text } from '../ui';
import AppHeader from '../components/AppHeader';
import api from '../api/client';
import { useAppState } from '../store/AppContext';

export default function JoinSessionScreen({ navigation }) {
  const me = useAppState().currentUser;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function join() {
    const clean = code.trim().toUpperCase();
    if (clean.length !== 5) {
      setError('Codes are 5 letters — check with your host.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await api.session(clean);
      if (session.host_user_id === me?.id) {
        navigation.replace('PlayFlow', { code: clean });
        return;
      }
      await api.joinSession(clean, me?.display_name || null).catch(() => {});
      navigation.replace('SessionViewer', { code: clean });
    } catch (e) {
      setError(e.status === 404 ? 'No open session with that code.' : e.message || 'Could not join.');
    }
    setBusy(false);
  }

  return (
    <Screen
      edges={{ top: false, bottom: true }}
      header={<AppHeader title="Join a session" onBack={() => navigation.goBack()} />}
      footer={<Button label="Join the table" onPress={join} busy={busy} full style={{ flex: 1 }} />}
    >
      <Stack gap="md" align="center" style={{ marginTop: SPACING.xxl }}>
        <Ticket size={40} color={COLORS.accent} />
        <Text variant="small" center>
          Ask the host for their 5-letter code.
        </Text>
        <Input
          value={code}
          onChangeText={(v) => {
            setCode(v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5));
            setError('');
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          placeholder="ABCDE"
          error={error || undefined}
          style={{ alignSelf: 'stretch' }}
          inputStyle={{
            fontFamily: FONTS.scoreBold,
            fontSize: 30,
            letterSpacing: 12,
            textAlign: 'center',
            minHeight: 64,
          }}
          onSubmitEditing={join}
        />
      </Stack>
    </Screen>
  );
}
