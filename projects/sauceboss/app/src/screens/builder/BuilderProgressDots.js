// Five-dot wizard progress indicator. Mirrors web's _wizardProgress
// (web/builder.js:81-99). Each dot is one of:
//   • skipped (greyed out — used for Source step when editing)
//   • done    (filled primary, the user has passed it)
//   • active  (current step, larger ring)
//   • pending (outlined, not yet reached)

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../theme';

export const WIZARD_STEPS = [
  { key: 'source', label: 'Source' },
  { key: 'info', label: 'Info' },
  { key: 'instructions', label: 'Steps' },
  { key: 'pairing', label: 'Pairing' },
  { key: 'review', label: 'Review' },
];

export default function BuilderProgressDots({ activeIndex, skipFirst }) {
  return (
    <View style={styles.wrap}>
      {WIZARD_STEPS.map((step, idx) => {
        const isSkipped = skipFirst && idx === 0;
        const isActive = idx === activeIndex;
        const isDone = !isSkipped && idx < activeIndex;
        return (
          <View key={step.key} style={styles.col}>
            <View
              style={[
                styles.dot,
                isActive && styles.dotActive,
                isDone && styles.dotDone,
                isSkipped && styles.dotSkipped,
              ]}
            >
              <Text
                style={[
                  styles.dotLabel,
                  (isActive || isDone) && styles.dotLabelLight,
                ]}
              >
                {idx + 1}
              </Text>
            </View>
            <Text
              style={[
                styles.label,
                isActive && styles.labelActive,
                isSkipped && styles.labelSkipped,
              ]}
            >
              {step.label}
            </Text>
            {idx < WIZARD_STEPS.length - 1 ? (
              <View
                style={[styles.line, isDone && styles.lineDone]}
                pointerEvents="none"
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  col: {
    flex: 1,
    alignItems: 'center',
    position: 'relative',
  },
  dot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  dotActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
    transform: [{ scale: 1.05 }],
  },
  dotDone: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
  },
  dotSkipped: {
    opacity: 0.35,
  },
  dotLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.textSecondary,
  },
  dotLabelLight: { color: '#fff' },
  label: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  labelActive: { color: COLORS.primary },
  labelSkipped: { opacity: 0.35 },
  line: {
    position: 'absolute',
    top: 13,
    left: '60%',
    right: '-40%',
    height: 2,
    backgroundColor: COLORS.border,
    zIndex: 0,
  },
  lineDone: { backgroundColor: COLORS.primary },
});
