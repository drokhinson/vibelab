// Text input. One look for every form field; `kind="score"` gives the numeric
// mono cell used by the round-score grid (with optional negative-sign toggle
// handled by the grid, not here).

import React, { forwardRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { COLORS, FONTS, RADII, SPACING } from '../theme';
import Text from './Text';

const Input = forwardRef(function Input(
  { label, hint, error, kind = 'text', bottomSheet = false, style, inputStyle, ...rest },
  ref,
) {
  const isScore = kind === 'score';
  // Inside a @gorhom bottom sheet the input must be the sheet's own so the
  // sheet resizes with the keyboard instead of covering the field.
  const Field = bottomSheet ? BottomSheetTextInput : TextInput;
  return (
    <View style={style}>
      {label ? (
        <Text variant="caption" style={{ marginBottom: SPACING.xs }}>
          {label}
        </Text>
      ) : null}
      <Field
        ref={ref}
        placeholderTextColor={COLORS.textMuted}
        keyboardType={isScore ? 'number-pad' : rest.keyboardType}
        style={[styles.input, isScore && styles.score, error && styles.errorBorder, inputStyle]}
        {...rest}
      />
      {error ? (
        <Text variant="small" color={COLORS.rustText} style={{ marginTop: SPACING.xs }}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" style={{ marginTop: SPACING.xs }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  input: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    color: COLORS.text,
    fontFamily: FONTS.sans,
    fontSize: 15,
    minHeight: 44,
  },
  score: {
    fontFamily: FONTS.score,
    fontSize: 16,
    textAlign: 'center',
    paddingHorizontal: SPACING.sm,
  },
  errorBorder: { borderColor: COLORS.rust },
});

export default Input;
