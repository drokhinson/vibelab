// 1-12 stepper. Mirrors web .servings-control.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

export default function ServingsControl({ value, onChange, min = 1, max = 12 }) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  const decDisabled = value <= min;
  const incDisabled = value >= max;
  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[styles.btn, decDisabled && styles.btnDisabled]}
        onPress={dec}
        disabled={decDisabled}
        activeOpacity={0.7}
      >
        <Text style={[styles.btnLabel, decDisabled && styles.btnLabelDisabled]}>−</Text>
      </TouchableOpacity>
      <Text style={styles.label}>
        {value} {value === 1 ? 'person' : 'people'}
      </Text>
      <TouchableOpacity
        style={[styles.btn, incDisabled && styles.btnDisabled]}
        onPress={inc}
        disabled={incDisabled}
        activeOpacity={0.7}
      >
        <Text style={[styles.btnLabel, incDisabled && styles.btnLabelDisabled]}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    opacity: 0.35,
  },
  btnLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.primary,
  },
  btnLabelDisabled: {
    color: COLORS.textMuted,
  },
  label: {
    minWidth: 92,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
});
