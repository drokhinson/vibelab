import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { COLORS, FONT_SIZES, RADII, SPACING } from '../theme';

export default function WordDisplay({ word }) {
  if (!word) return null;
  return (
    <View style={styles.wrap}>
      <Text style={styles.word}>{word.word}</Text>
      <View style={styles.defRow}>
        {word.part_of_speech ? (
          <Text style={styles.pos}>{word.part_of_speech}.</Text>
        ) : null}
        <Text style={styles.def}>{word.definition}</Text>
      </View>
      {word.etymology ? (
        <View style={styles.etymCard}>
          <Text style={styles.etymLabel}>Etymology: </Text>
          <Text style={styles.etymText}>{word.etymology}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: SPACING.lg, paddingVertical: SPACING.lg },
  word: {
    fontSize: 36,
    fontWeight: '800',
    color: COLORS.text,
    textAlign: 'center',
    letterSpacing: 0.5,
    marginBottom: SPACING.sm,
  },
  defRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  pos: { fontStyle: 'italic', color: COLORS.textMuted, marginRight: SPACING.xs, fontSize: FONT_SIZES.card },
  def: { color: COLORS.textSecondary, fontSize: FONT_SIZES.card, lineHeight: 22 },
  etymCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: COLORS.surfaceSubtle,
    padding: SPACING.md,
    borderRadius: RADII.md,
    marginTop: SPACING.lg,
  },
  etymLabel: { fontWeight: '700', color: COLORS.text, fontSize: FONT_SIZES.small },
  etymText: { color: COLORS.textSecondary, fontSize: FONT_SIZES.small, flexShrink: 1 },
});
