// OfflineBanner — the one surface for the app's connectivity state. Renders
// nothing while online, so it can be mounted unconditionally next to
// PendingUploadsBar (Feed + the Play tab) and costs nothing when there's
// signal.
//
// "Try again" is the only active probe in the app. Everything else about
// offline detection is passive — offline/net.js learns from requests the app
// was making anyway — but a user who can see they have bars needs a way to say
// so without hunting for a screen that happens to fetch.

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { WifiOff, RefreshCw } from 'lucide-react-native';
import { COLORS, RADII, SPACING } from '../theme';
import { Row, Text } from '../ui';
import { isOffline, isProbing, probe, subscribeNet } from '../offline/net';

export default function OfflineBanner({ style }) {
  const [offline, setOffline] = useState(isOffline());
  const [busy, setBusy] = useState(isProbing());

  useEffect(() => subscribeNet(setOffline), []);

  if (!offline) return null;

  async function tryAgain() {
    setBusy(true);
    await probe();
    setBusy(false);
  }

  return (
    <View style={[styles.wrap, style]}>
      <Row gap="sm">
        <WifiOff size={16} color={COLORS.textSoft} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium" style={{ fontSize: 13 }}>
            No connection
          </Text>
          <Text variant="caption">You can still host a game — it uploads when you're back.</Text>
        </View>
        <Pressable onPress={tryAgain} disabled={busy} hitSlop={8} style={styles.retryBtn}>
          <RefreshCw size={14} color={COLORS.textSoft} />
          <Text variant="caption" color={COLORS.textSoft}>
            {busy ? 'Checking…' : 'Try again'}
          </Text>
        </Pressable>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.cardSoft,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.bgElevated,
    minHeight: 34,
  },
});
