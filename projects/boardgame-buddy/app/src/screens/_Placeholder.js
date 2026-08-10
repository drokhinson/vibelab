// Placeholder screen factory — each milestone replaces its screens' stub files
// with real implementations. Deleted once every screen is built.

import React from 'react';
import { Screen, Stack, Text } from '../ui';

export function makePlaceholder(title) {
  return function PlaceholderScreen() {
    return (
      <Screen>
        <Stack gap="sm" align="center" style={{ flex: 1, justifyContent: 'center' }}>
          <Text variant="title">{title}</Text>
          <Text variant="small">Coming together in a later milestone.</Text>
        </Stack>
      </Screen>
    );
  };
}
