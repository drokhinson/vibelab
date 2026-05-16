// Search-input → suggest-dropdown → selected-chips filter row.
// Used by Browse and Saucebook so the Cuisine / Pairs-with / Author filters
// render identically across the two screens. Long catalogs (cuisines,
// dishes, all authors) would crowd the panel as chip grids, so we hide the
// full list behind a query.
//
// Props:
//   label          — section header text (e.g. "Cuisine")
//   placeholder    — search input placeholder
//   query / onQueryChange — controlled search input value
//   onQuerySubmit  — optional, fired on text change for dynamic-fetch sources
//   suggestions    — array of { id, label } to surface in the dropdown
//                     (parent does the filtering against `query`)
//   selected       — array of { id, label } currently chosen — rendered as
//                     pill chips below the input with an ✕ to remove
//   onPick         — (id) => void — fires when user taps a suggestion
//   onRemove       — (id) => void — fires when user taps the ✕ on a chip
//   minQueryLength — drop search hides until at least this many chars typed (default 1)

import React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Search, X } from 'lucide-react-native';
import { COLORS } from '../theme';

export default function FilterPicker({
  label,
  placeholder,
  query,
  onQueryChange,
  onQuerySubmit,
  suggestions = [],
  selected = [],
  onPick,
  onRemove,
  minQueryLength = 1,
}) {
  const trimmed = (query || '').trim();
  const showDropdown = trimmed.length >= minQueryLength && suggestions.length > 0;
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.searchWrap}>
        <Search size={14} color={COLORS.textMuted} />
        <TextInput
          style={styles.input}
          value={query || ''}
          onChangeText={(v) => {
            onQueryChange(v);
            if (onQuerySubmit) onQuerySubmit(v);
          }}
          placeholder={placeholder}
          placeholderTextColor={COLORS.textMuted}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {query ? (
          <TouchableOpacity onPress={() => onQueryChange('')} hitSlop={8}>
            <X size={12} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
      {showDropdown ? (
        <View style={styles.dropdown}>
          {suggestions.map((s) => (
            <TouchableOpacity
              key={s.id}
              onPress={() => onPick(s.id)}
              style={styles.suggestItem}
              activeOpacity={0.7}
            >
              <Text style={styles.suggestLabel}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {selected.length > 0 ? (
        <View style={styles.chipRow}>
          {selected.map((s) => (
            <TouchableOpacity
              key={s.id}
              onPress={() => onRemove(s.id)}
              style={styles.chip}
              activeOpacity={0.8}
            >
              <Text style={styles.chipLabel}>{s.label} ✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    padding: 0,
  },
  dropdown: {
    marginTop: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 2,
    borderTopColor: COLORS.primary,
    backgroundColor: COLORS.card,
    overflow: 'hidden',
  },
  suggestItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  suggestLabel: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.primary,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
});
