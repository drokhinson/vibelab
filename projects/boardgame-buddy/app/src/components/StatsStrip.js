// StatsStrip — the Strava-style stats row shown on every profile. Consistent
// across self + other profiles.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS, FONTS, SPACING } from '../theme';

function fmtHours(h) {
  const n = Number(h || 0);
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1);
}

export default function StatsStrip({ stats }) {
  if (!stats) return null;
  const items = [
    { label: 'Plays', value: stats.total_plays || 0 },
    { label: 'Games', value: stats.unique_games || 0 },
    { label: 'Wins', value: stats.win_count || 0 },
    { label: 'Hours', value: fmtHours(stats.hours_played) },
  ];
  return (
    <View style={styles.strip}>
      {items.map((it) => (
        <View key={it.label} style={styles.cell}>
          <Text style={styles.value}>{it.value}</Text>
          <Text style={styles.label}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', backgroundColor: COLORS.card, borderRadius: 16, paddingVertical: SPACING.md, borderWidth: 1, borderColor: COLORS.borderSoft },
  cell: { flex: 1, alignItems: 'center' },
  value: { fontFamily: FONTS.displayBold, color: COLORS.accent, fontSize: 24 },
  label: { fontFamily: FONTS.sansMedium, color: COLORS.textMuted, fontSize: 12, marginTop: 2 },
});
