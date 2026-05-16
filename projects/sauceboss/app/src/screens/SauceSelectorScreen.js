// Sauce / dressing / marinade selector — accordions by cuisine, family-grouped,
// with the ingredient pantry filter.

import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import IngredientFilterPanel from '../components/IngredientFilterPanel';
import CuisineAccordion from '../components/CuisineAccordion';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import LoadingPot from '../components/LoadingPot';
import { useAppActions, useAppState } from '../store/AppContext';
import { buildSauceFamilies, pickDisplayedFromFamily } from '#shared/families';
import { isSauceAvailable } from '#shared/filter';
import { flowMetaFor } from '#shared/constants';
import { COLORS } from '../theme';

export default function SauceSelectorScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();

  const item = state.selectedItem;
  const prep = state.selectedPrep;
  const meta = flowMetaFor(item);

  // Build families + decide which sauce to show per family.
  const visibleEntries = useMemo(() => {
    const families = buildSauceFamilies(state.saucesForCurrentItem || []);
    return [...families.values()].map((family) => ({
      family,
      displayed: pickDisplayedFromFamily(family),
    }));
  }, [state.saucesForCurrentItem]);

  const cuisines = useMemo(
    () => [...new Set(visibleEntries.map((e) => e.displayed.cuisine || 'Other'))],
    [visibleEntries],
  );

  const onSelect = (sauce, family) => {
    const fullFamily = [family.root, ...family.variants];
    actions.selectSauce(sauce, fullFamily);
    navigation.navigate('Recipe');
  };

  const totalFamilies = visibleEntries.length;
  const availableFamilies = visibleEntries.filter(
    (e) => isSauceAvailable(e.displayed, state.disabledIngredients),
  ).length;

  // Going back from the sauce list: if a prep variant was picked, return
  // to PrepSelector; otherwise jump straight back to MealBuilder.
  const backLabel = prep ? 'Preparation' : 'Meal Builder';
  function goBackStep() {
    if (prep) navigation.navigate('PrepSelector');
    else navigation.navigate('MealBuilder');
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        title="Meal Builder"
        subtitle="Step 3 of 3 · Pick a sauce"
        back={() => navigation.navigate('Home', { screen: 'SaucebookTab' })}
        closeIcon
        manage={false}
        auth={false}
        navigation={navigation}
      />
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {item ? `${item.emoji} ${item.name}` : 'Sauces'}
              {prep ? ` — ${prep.name}` : ''}
            </Text>
            <Text style={styles.subtitle}>
              {availableFamilies} of {totalFamilies}{' '}
              {totalFamilies === 1 ? meta.sauceWord.toLowerCase() : meta.sauceTypeLabel} match your pantry
            </Text>
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollBody}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {state.itemLoading ? (
          <LoadingPot label={`Loading ${item ? item.name.toLowerCase() : 'options'} ${meta.sauceTypeLabel}…`} />
        ) : state.itemError ? (
          <EmptyState
            title="Couldn't load sauces"
            body={state.itemError}
            action="Back to home"
            onAction={() => navigation.navigate('MealBuilder')}
          />
        ) : (
          <>
            <IngredientFilterPanel
              ingredients={state.allIngredients}
              sauces={state.saucesForCurrentItem}
              ingredientCategories={state.ingredientCategories}
              disabledIngredients={state.disabledIngredients}
              isOpen={state.filterOpen}
              onToggleOpen={(open) => actions.setFilterOpen(open)}
              onToggleIngredient={(name) => actions.toggleIngredient(name)}
              onClear={actions.clearFilter}
            />

            {cuisines.length === 0 ? (
              <EmptyState
                title="Nothing matches"
                body="Try enabling more ingredients in your pantry."
              />
            ) : (
              cuisines.map((cuisine) => {
                const entries = visibleEntries.filter(
                  (e) => (e.displayed.cuisine || 'Other') === cuisine,
                );
                const cuisineEmoji = entries[0]?.displayed.cuisineEmoji || '🍽️';
                const isOpen = state.expandedCuisines.has(cuisine);
                return (
                  <CuisineAccordion
                    key={cuisine}
                    cuisine={cuisine}
                    cuisineEmoji={cuisineEmoji}
                    entries={entries}
                    isOpen={isOpen}
                    disabledIngredients={state.disabledIngredients}
                    onToggle={() => actions.toggleCuisine(cuisine)}
                    onSelectSauce={onSelect}
                  />
                );
              })
            )}

            {/* In-flow back link — header X exits the whole meal flow; this
                link walks one step back (to PrepSelector if a prep was
                picked, otherwise to MealBuilder). */}
            <TouchableOpacity
              style={styles.backLink}
              onPress={goBackStep}
              activeOpacity={0.7}
            >
              <Text style={styles.backLinkLabel}>← Back to {backLabel}</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  subtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  scrollBody: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  backLink: {
    marginTop: 16,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  backLinkLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
  },
});
