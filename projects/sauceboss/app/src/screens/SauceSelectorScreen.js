import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { getSaucesForCarb, getIngredientsForCarb } from '../data/database';
import IngredientFilterPanel from '../components/IngredientFilterPanel';
import CuisineAccordion from '../components/CuisineAccordion';
import { COLORS } from '../theme';

export default function SauceSelectorScreen({ route, navigation }) {
  const { carb } = route.params;
  const db = useSQLiteContext();

  const [compatibleSauces, setCompatibleSauces] = useState([]);
  const [allIngredients, setAllIngredients]     = useState([]);
  const [loading, setLoading]                   = useState(true);

  useEffect(() => {
    Promise.all([
      getSaucesForCarb(db, carb.id),
      getIngredientsForCarb(db, carb.id),
    ]).then(([sauces, ingredients]) => {
      setCompatibleSauces(sauces);
      setAllIngredients(ingredients);
      setLoading(false);
    });
  }, [db, carb.id]);

  const cuisines = [...new Set(compatibleSauces.map(s => s.cuisine))];

  // Ingredient filter state — Set of ingredient names the user does NOT have
  const [disabledIngredients, setDisabledIngredients] = useState(new Set());

  // Auto-open the first cuisine
  const [expandedCuisines, setExpandedCuisines] = useState(new Set());
  useEffect(() => {
    if (compatibleSauces.length > 0) {
      setExpandedCuisines(new Set([compatibleSauces[0].cuisine]));
    }
  }, [compatibleSauces]);

  const toggleIngredient = useCallback((name) => {
    setDisabledIngredients(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleCuisine = useCallback((name) => {
    setExpandedCuisines(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  function isSauceAvailable(sauce) {
    return sauce.ingredients.every(ing => !disabledIngredients.has(ing.name));
  }

  const unavailableCount = compatibleSauces.filter(s => !isSauceAvailable(s)).length;
  const availableCount   = compatibleSauces.length - unavailableCount;

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={styles.loader} size="large" color={COLORS.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Summary strip */}
        <View style={styles.strip}>
          <Text style={styles.stripText}>
            <Text style={styles.stripHighlight}>{availableCount}</Text>
            {' '}of {compatibleSauces.length} sauces available
          </Text>
          {unavailableCount > 0 && (
            <Text style={styles.stripMuted}> · {unavailableCount} hidden</Text>
          )}
        </View>

        {/* Ingredient filter */}
        <Text style={styles.sectionLabel}>PANTRY FILTER</Text>
        <IngredientFilterPanel
          ingredients={allIngredients}
          disabledIngredients={disabledIngredients}
          onToggle={toggleIngredient}
          unavailableCount={unavailableCount}
        />

        {/* Cuisine accordions */}
        <Text style={styles.sectionLabel}>PICK A SAUCE</Text>
        {cuisines.map(cuisine => {
          const saucesInCuisine = compatibleSauces.filter(s => s.cuisine === cuisine);
          return (
            <CuisineAccordion
              key={cuisine}
              cuisine={cuisine}
              cuisineEmoji={saucesInCuisine[0]?.cuisineEmoji ?? '🍽️'}
              sauces={saucesInCuisine}
              isOpen={expandedCuisines.has(cuisine)}
              disabledIngredients={disabledIngredients}
              onToggle={() => toggleCuisine(cuisine)}
              onSelectSauce={(sauce) => navigation.navigate('Recipe', { sauce, carb })}
            />
          );
        })}

        {unavailableCount > 0 && (
          <Text style={styles.footNote}>
            {unavailableCount} sauce{unavailableCount > 1 ? 's' : ''} hidden due to missing ingredients.{' '}
            Tap Pantry Filter above to restore them.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scroll: {
    padding: 16,
    paddingBottom: 40,
  },
  strip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 16,
  },
  stripText: {
    fontSize: 15,
    color: COLORS.text,
    fontWeight: '600',
  },
  stripHighlight: {
    color: COLORS.primary,
    fontWeight: '800',
    fontSize: 17,
  },
  stripMuted: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: COLORS.textMuted,
    marginBottom: 8,
  },
  footNote: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
});
