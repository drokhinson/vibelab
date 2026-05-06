// Imperial / Metric toggle. Mirrors web .unit-toggle.

import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

export default function UnitToggle({ value, onChange }) {
  const next = value === 'imperial' ? 'metric' : 'imperial';
  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={() => onChange(next)}
      activeOpacity={0.7}
    >
      <Text style={styles.label}>{value === 'imperial' ? 'Imperial' : 'Metric'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
  },
});
