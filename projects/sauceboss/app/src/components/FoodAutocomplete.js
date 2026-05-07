// Debounced food name typeahead. Calls /foods?q= 250ms after the user stops
// typing and shows the top 6 matches. Tap a match to set the value; tap the
// trailing "Use as new" pill to keep what's typed (creates a new food on save).

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { api } from '../api/client';
import { COLORS } from '../theme';

export default function FoodAutocomplete({ value, onChange, onPickFood, placeholder = 'Ingredient' }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounce = useRef(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!value || value.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try {
        const foods = await api.foods(value.trim(), 6);
        setResults(foods || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => debounce.current && clearTimeout(debounce.current);
  }, [value]);

  function pick(food) {
    onChange(food.name);
    if (onPickFood) onPickFood(food);
    setOpen(false);
  }

  const showDropdown = open && (loading || results.length > 0);

  return (
    <View style={styles.wrap}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(v) => {
          onChange(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        placeholderTextColor={COLORS.textMuted}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {showDropdown ? (
        <View style={styles.dropdown}>
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={COLORS.primary} size="small" />
            </View>
          ) : (
            results.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={styles.result}
                onPress={() => pick(f)}
                activeOpacity={0.7}
              >
                <Text style={styles.resultName}>{f.name}</Text>
                {f.plural && f.plural !== f.name ? (
                  <Text style={styles.resultPlural}> · {f.plural}</Text>
                ) : null}
              </TouchableOpacity>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: COLORS.text,
  },
  dropdown: {
    backgroundColor: COLORS.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 2,
  },
  loadingRow: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  result: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.surfaceSubtle,
  },
  resultName: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
  },
  resultPlural: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
});
