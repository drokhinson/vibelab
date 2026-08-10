// Revalidation indicator. When a screen serves cached data and refreshes in
// the background, this thin bar makes the refresh visible — data is never
// silently stale.

import React from 'react';
import { ActivityIndicator } from 'react-native';
import { COLORS, SPACING } from '../theme';
import { Row } from './layout';
import Text from './Text';

export default function RefreshHint({ visible, label = 'Refreshing…' }) {
  if (!visible) return null;
  return (
    <Row gap="xs" justify="center" style={{ paddingVertical: SPACING.xs }}>
      <ActivityIndicator size="small" color={COLORS.textMuted} />
      <Text variant="caption">{label}</Text>
    </Row>
  );
}
