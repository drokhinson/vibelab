// SessionRouter — resolves the ambiguous /play/:code deep link. Fetches the
// session, then replaces itself with PlayFlow (host resuming) or
// SessionViewer (joiner). Dead codes get a friendly notice, not a crash.

import React, { useEffect } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { useAppState } from '../store/AppContext';
import LoadingState from '../components/LoadingState';
import { alert as alertModal } from '../components/ConfirmModal';
import api from '../api/client';

export default function SessionRouter({ navigation, route }) {
  const code = (route.params?.code || '').toUpperCase();
  const { currentUser, authReady } = useAppState();

  useEffect(() => {
    if (!authReady) return undefined;
    let active = true;
    (async () => {
      if (!currentUser) {
        navigation.replace('Auth');
        return;
      }
      try {
        const session = await api.session(code);
        if (!active) return;
        if (session.status !== 'open' || session.phase === 'abandoned' || session.phase === 'finalized') {
          await alertModal({ title: 'Session over', body: 'That table already wrapped up or was closed.' });
          navigation.replace('Home', { screen: 'PlayTab' });
        } else if (session.host_user_id === currentUser.id) {
          navigation.replace('PlayFlow', { code });
        } else {
          navigation.replace('SessionViewer', { code });
        }
      } catch (e) {
        if (!active) return;
        await alertModal({ title: 'Session unavailable', body: e.message || 'That session could not be found.' });
        navigation.replace('Home', { screen: 'PlayTab' });
      }
    })();
    return () => {
      active = false;
    };
  }, [code, currentUser, authReady, navigation]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center' }}>
      <LoadingState label="Opening session…" />
    </SafeAreaView>
  );
}
