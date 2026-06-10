// SearchScreen — unified game search via GameFinder; tapping a result opens
// the game detail. Mirrors the web search flow.

import React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, SPACING } from '../theme';
import AppHeader from '../components/AppHeader';
import GameFinder from '../widgets/GameFinder';

export default function SearchScreen({ navigation }) {
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader title="Search games" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <GameFinder
          autoFocus
          placeholder="Search your shelf or BoardGameGeek…"
          onPick={(game) => navigation.navigate('GameDetail', { gameId: game.id, gameName: game.name })}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  body: { padding: SPACING.lg },
});
