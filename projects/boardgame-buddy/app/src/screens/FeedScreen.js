// src/screens/FeedScreen.js — home feed. Phase 1 ships the shell; the
// chronological play feed + rails land in Phase 2 with the cache layer.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Newspaper } from 'lucide-react-native';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import { COLORS } from '../theme';

export default function FeedScreen() {
  return (
    <View style={styles.flex}>
      <AppHeader title="BoardgameBuddy" subtitle="Your plays & buddies" />
      <EmptyState
        icon={<Newspaper size={48} color={COLORS.accent} />}
        title="Your feed is warming up"
        message="Plays from you and your buddies will appear here. The live feed lands in the next build."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
});
