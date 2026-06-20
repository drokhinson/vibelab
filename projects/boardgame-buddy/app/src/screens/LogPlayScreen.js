// src/screens/LogPlayScreen.js — the Log tab. Phase 1 ships the shell; the
// Host/Join chooser and the full Gather → Play → Settle cascade land in Phase 5.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Dice5 } from 'lucide-react-native';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import { COLORS } from '../theme';

export default function LogPlayScreen() {
  return (
    <View style={styles.flex}>
      <AppHeader title="Log a play" subtitle="Host or join a game" />
      <EmptyState
        icon={<Dice5 size={48} color={COLORS.accent} />}
        title="Game night, coming soon"
        message="Hosting a session, inviting buddies by code, and live scoring arrive in a later build."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
});
