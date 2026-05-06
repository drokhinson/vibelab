// Inline loader showing the animated pot + a label. Mirrors web .loading-inline.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import PotIllustration from './PotIllustration';
import { COLORS } from '../theme';

export default function LoadingPot({ label = 'Warming up the kitchen…' }) {
  return (
    <View style={styles.wrap}>
      <PotIllustration width={140} height={108} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  label: {
    marginTop: 14,
    fontSize: 14,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },
});
