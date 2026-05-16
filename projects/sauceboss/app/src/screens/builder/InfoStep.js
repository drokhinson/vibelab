// Wizard step 2 — Info. Name, Description, Cuisine (grid + "+ New Cuisine"),
// Color. Mirrors web's renderBuilderInfo (web/builder.js:178-235). Type and
// Source URL live on other steps / are derived elsewhere.

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Plus } from 'lucide-react-native';
import { COLOR_SWATCHES } from '#shared/constants';
import builderStyles from './builderStyles';
import { COLORS } from '../../theme';

export default function InfoStep({ builder, refCuisines, patch, pickCuisine }) {
  const [showNewCuisine, setShowNewCuisine] = useState(false);
  const [newCuisineName, setNewCuisineName] = useState('');
  const [newCuisineEmoji, setNewCuisineEmoji] = useState('');

  const cancelNewCuisine = () => {
    setShowNewCuisine(false);
    setNewCuisineName('');
    setNewCuisineEmoji('');
  };

  const saveNewCuisine = () => {
    const name = newCuisineName.trim();
    if (!name) return;
    pickCuisine({ name, emoji: newCuisineEmoji.trim() || '🍽' });
    cancelNewCuisine();
  };

  return (
    <View style={builderStyles.card}>
      <Text style={[builderStyles.fieldHeader, { marginTop: 4 }]}>Name</Text>
      <TextInput
        style={builderStyles.input}
        value={builder.name}
        onChangeText={(v) => patch({ name: v })}
        placeholder="Garlic butter pan sauce"
        placeholderTextColor={COLORS.textMuted}
      />

      <Text style={builderStyles.fieldHeader}>Description</Text>
      <TextInput
        style={[builderStyles.input, builderStyles.multiline]}
        value={builder.description}
        onChangeText={(v) => patch({ description: v })}
        placeholder="Bright, lemony, ready in 5 minutes"
        placeholderTextColor={COLORS.textMuted}
        multiline
      />

      <Text style={builderStyles.fieldHeader}>Cuisine</Text>
      <View style={styles.cuisineGrid}>
        {(refCuisines || []).map((c) => {
          const name = c.cuisine || c.name;
          const emoji = c.emoji || '🍽';
          const active = builder.cuisine === name;
          return (
            <TouchableOpacity
              key={name}
              onPress={() => pickCuisine({ name, emoji })}
              style={[styles.cuisineCell, active && styles.cuisineCellActive]}
              activeOpacity={0.8}
            >
              <Text style={[styles.cuisineCellLabel, active && styles.cuisineCellLabelActive]}>
                {emoji} {name}
              </Text>
            </TouchableOpacity>
          );
        })}
        {/* Show the current cuisine in the grid even if it's not in refCuisines
            (e.g. just added via "+ New Cuisine"). */}
        {builder.cuisine && !(refCuisines || []).some((c) => (c.cuisine || c.name) === builder.cuisine) ? (
          <View style={[styles.cuisineCell, styles.cuisineCellActive]}>
            <Text style={[styles.cuisineCellLabel, styles.cuisineCellLabelActive]}>
              {builder.cuisineEmoji || '🍽'} {builder.cuisine}
            </Text>
          </View>
        ) : null}
      </View>

      {showNewCuisine ? (
        <View style={styles.newCuisineForm}>
          <TextInput
            style={[builderStyles.input, { flex: 1 }]}
            value={newCuisineName}
            onChangeText={setNewCuisineName}
            placeholder="Cuisine name"
            placeholderTextColor={COLORS.textMuted}
          />
          <TextInput
            style={[builderStyles.input, styles.emojiInput]}
            value={newCuisineEmoji}
            onChangeText={setNewCuisineEmoji}
            placeholder="🍽"
            placeholderTextColor={COLORS.textMuted}
            maxLength={2}
          />
          <TouchableOpacity
            style={[builderStyles.smallBtn, !newCuisineName.trim() && builderStyles.btnDisabled]}
            onPress={saveNewCuisine}
            disabled={!newCuisineName.trim()}
          >
            <Text style={builderStyles.smallBtnLabel}>Add</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={builderStyles.smallBtnSecondary}
            onPress={cancelNewCuisine}
          >
            <Text style={builderStyles.smallBtnSecondaryLabel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.newCuisineBtn}
          onPress={() => setShowNewCuisine(true)}
          activeOpacity={0.8}
        >
          <Plus size={14} color={COLORS.primary} />
          <Text style={styles.newCuisineBtnLabel}>New Cuisine</Text>
        </TouchableOpacity>
      )}

      <Text style={builderStyles.fieldHeader}>Color</Text>
      <View style={builderStyles.swatchRow}>
        {(() => {
          const current = (builder.color || '').toLowerCase();
          // Saved color might be a custom hex outside the palette (legacy
          // sauces, hand-edited rows). Append it as an extra swatch so the
          // editor always shows what's actually selected.
          const inPalette = COLOR_SWATCHES.some((sw) => sw.toLowerCase() === current);
          const swatches = inPalette || !current ? COLOR_SWATCHES : [...COLOR_SWATCHES, builder.color];
          return swatches.map((sw) => {
            const active = (sw || '').toLowerCase() === current;
            return (
              <TouchableOpacity
                key={sw}
                onPress={() => patch({ color: sw })}
                style={[
                  builderStyles.swatch,
                  { backgroundColor: sw },
                  active && builderStyles.swatchActive,
                ]}
              />
            );
          });
        })()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cuisineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  cuisineCell: {
    width: '48%',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  cuisineCellActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  cuisineCellLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  cuisineCellLabelActive: {
    color: '#fff',
  },
  newCuisineBtn: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  newCuisineBtnLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
  },
  newCuisineForm: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  emojiInput: {
    width: 56,
    textAlign: 'center',
  },
});
