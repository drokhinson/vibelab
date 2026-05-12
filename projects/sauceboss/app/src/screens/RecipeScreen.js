// Unified recipe view — handles both standalone (SauceManager) and
// meal-builder flows. When state.meal has item + sauce, the dish prep block
// is shown after the controls. Otherwise it's sauce-only.

import React, { useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Lightbulb } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import StepCard from '../components/StepCard';
import VariantSwitcher from '../components/VariantSwitcher';
import ServingsControl from '../components/ServingsControl';
import UnitToggle from '../components/UnitToggle';
import EmptyState from '../components/EmptyState';
import { SAUCE_TYPES, flowMetaFor } from '#shared/constants';
import { COLORS, SHADOWS } from '../theme';

export default function RecipeScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const sauce = state.selectedSauce;

  // Meal-builder context
  const isMeal = !!(state.meal && state.meal.item && state.meal.sauce);
  const item = isMeal ? state.meal.item : null;
  const prep = isMeal ? state.meal.prep : null;

  // Set header title to sauce name
  useEffect(() => {
    if (sauce) navigation.setOptions({ title: sauce.name });
  }, [sauce?.name, navigation]);

  if (!sauce) {
    return (
      <View style={styles.screen}>
        <EmptyState
          body="Pick a sauce from the manager first."
          action="Open Sauce Manager"
          onAction={() => navigation.navigate('SauceManager')}
        />
      </View>
    );
  }

  const family = state.selectedSauceFamily;
  const meta = isMeal
    ? flowMetaFor(item)
    : SAUCE_TYPES.find((t) => t.value === (sauce.sauceType || 'sauce')) || SAUCE_TYPES[0];
  const isMarinade = sauce.sauceType === 'marinade';

  const sauceColor = isMarinade ? '#5D4037'
    : sauce.sauceType === 'dressing' ? '#1B5E20'
    : '#4A0072';

  const sauceLabel = isMeal
    ? `${meta.sauceWord} — ${sauce.name}`
    : `${meta.label} — ${sauce.name}`;

  const onPickVariant = (next) => {
    if (next.id === sauce.id) return;
    actions.selectVariant(next);
  };

  // Item prep card (meal flow only)
  const itemSection = item ? (() => {
    const itemPrepLabel = item.category === 'salad'
      ? `🥗 Toss ${item.name}`
      : `${item.emoji} ${item.category === 'protein' ? 'Cook' : 'Prep'} ${item.name}${prep ? ` — ${prep.name}` : ''}`;
    const itemColor = item.category === 'protein' ? '#C94E02'
      : item.category === 'salad' ? '#2D6A4F'
      : '#1565C0';
    const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
    const itemInstructions = prep?.instructions
      || item.instructions
      || (item.category === 'salad'
        ? `Toss ${item.name} with ${sauce.name} right before serving`
        : `Cook ${item.name} per packet instructions`);
    return (
      <View style={styles.section}>
        <View style={[styles.sectionLabel, { backgroundColor: itemColor }]}>
          <Text style={styles.sectionLabelText}>{itemPrepLabel}</Text>
        </View>
        <View style={styles.itemCard}>
          <View style={styles.itemHeaderRow}>
            <Text style={styles.itemNumber}>
              {item.category === 'protein' ? 'Cook' : item.category === 'salad' ? 'Assemble' : 'Boil / prep'}
            </Text>
            {itemCookTime ? <Text style={styles.itemTime}>~{itemCookTime}m</Text> : null}
          </View>
          <Text style={styles.itemTitle}>{itemInstructions}</Text>
        </View>
      </View>
    );
  })() : null;

  const sauceSection = (
    <View style={styles.section}>
      <View style={[styles.sectionLabel, { backgroundColor: sauceColor }]}>
        <Text style={styles.sectionLabelText}>{sauceLabel}</Text>
      </View>
      {(sauce.steps || []).map((step, i) => (
        <StepCard
          key={`${sauce.id}-${i}`}
          step={step}
          index={i}
          steps={sauce.steps}
          servings={state.servings}
          unitSystem={state.unitSystem}
          baseServings={sauce.defaultServings || 2}
          disabledIngredients={state.disabledIngredients}
          substitutions={state.substitutions}
        />
      ))}
    </View>
  );

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
        {family && family.length > 1 ? (
          <View style={styles.variantWrap}>
            <VariantSwitcher family={family} currentId={sauce.id} onSelect={onPickVariant} />
          </View>
        ) : null}

        <View style={styles.controlsRow}>
          <ServingsControl value={state.servings} onChange={(v) => actions.setServings(v)} />
          <UnitToggle value={state.unitSystem} onChange={(v) => actions.setUnitSystem(v)} />
        </View>

        {isMeal && isMarinade ? (
          <>
            {sauceSection}
            {itemSection}
          </>
        ) : isMeal ? (
          <>
            {itemSection}
            {sauceSection}
          </>
        ) : (
          sauceSection
        )}

        <View style={styles.tipCard}>
          <Lightbulb size={16} color={COLORS.primary} />
          <View style={styles.tipBody}>
            <Text style={styles.tipTitle}>How to read the chart</Text>
            <Text style={styles.tipText}>
              Each slice is proportional to that ingredient's amount in the bowl. Larger slice = more of it.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  scrollBody: {
    padding: 16,
    paddingBottom: 32,
  },
  variantWrap: {
    marginBottom: 8,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  section: {
    marginBottom: 16,
  },
  sectionLabel: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    marginBottom: 1,
  },
  sectionLabelText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  itemCard: {
    backgroundColor: COLORS.card,
    padding: 14,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    ...SHADOWS.sm,
  },
  itemHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  itemNumber: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 0.5,
  },
  itemTime: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    lineHeight: 20,
  },
  tipCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.info,
    borderRadius: 12,
    padding: 12,
    marginTop: 6,
  },
  tipBody: {
    marginLeft: 8,
    flex: 1,
  },
  tipTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.infoText,
    marginBottom: 2,
  },
  tipText: {
    fontSize: 12,
    color: COLORS.infoText,
    lineHeight: 16,
  },
});
