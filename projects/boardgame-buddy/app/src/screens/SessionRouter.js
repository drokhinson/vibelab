// SessionRouter — resolves the ambiguous /play/:code link (host vs joiner). It
// fetches the lobby, compares host_user_id to the current user, then replaces
// itself with PlayFlow (host) or SessionViewer (joiner). Mirrors the host/joiner
// hop in web/views/play-flow-view.js onMount.

import React, { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { useAppState } from '../store/AppContext';
import LoadingState from '../components/LoadingState';
import { alert as alertModal } from '../components/ConfirmModal';
import api from '../api/client';

export default function SessionRouter({ navigation, route }) {
  const code = route.params?.code;
  const state = useAppState();

  useEffect(() => {
    let active = true;
    (async () => {
      if (!state.currentUser) {
        navigation.replace('Auth');
        return;
      }
      try {
        const session = await api.session(code);
        if (!active) return;
        if (session.host_user_id === state.currentUser.id) {
          navigation.replace('PlayFlow', { code });
        } else {
          navigation.replace('SessionViewer', { code });
        }
      } catch (e) {
        if (!active) return;
        await alertModal({ title: "Session unavailable", body: e.message || 'That session could not be found.' });
        navigation.replace('Home');
      }
    })();
    return () => { active = false; };
  }, [code, state.currentUser]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg }}>
      <LoadingState label="Opening session…" />
    </SafeAreaView>
  );
}
