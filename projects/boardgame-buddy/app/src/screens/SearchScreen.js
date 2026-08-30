// SearchScreen — full-screen GameFinder. Picking a game opens its detail.

import React from 'react';
import AppHeader from '../components/AppHeader';
import GameFinder from '../widgets/GameFinder';
import { Screen } from '../ui';

export default function SearchScreen({ navigation }) {
  return (
    <Screen
      scroll
      edges={{ top: false, bottom: true }}
      header={<AppHeader title="Find a game" onBack={() => navigation.goBack()} />}
    >
      <GameFinder
        autoFocus
        includeRecentlyPlayed
        onPick={(game) => navigation.replace('GameDetail', { gameId: game.id, gameName: game.name })}
      />
    </Screen>
  );
}
