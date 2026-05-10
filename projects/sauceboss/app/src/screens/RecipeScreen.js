// Single-sauce recipe view. Used when the user opens a sauce from the
// SauceManager (no item context). The full meal flow goes through
// MealRecipeScreen.

import React, { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Clock, TriangleAlert, Lightbulb } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import StepCard from '../components/StepCard';
import VariantSwitcher from '../components/VariantSwitcher';
import ServingsControl from '../components/ServingsControl';
import UnitToggle from '../components/UnitToggle';
import EmptyState from '../components/EmptyState';
import { SAUCE_TYPES } from '#shared/constants';
import { COLORS, SHADOWS } from '../theme';

export default function RecipeScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const sauce = state.selectedSauce;

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
  const meta = SAUCE_TYPES.find((t) => t.value === (sauce.sauceType || 'sauce')) || SAUCE_TYPES[0];
  const sauceTime = useMemo(
    () => (sauce.steps || []).reduce((s, st) => s + (st.estimatedTime || 5), 0),
    [sauce.steps],
  );
  const isMarinade = sauce.sauceType === 'marinade';
  const marineAhead = isMarinade && sauceTime > 20;

  const sauceColor = isMarinade ? '#5D4037'
    : sauce.sauceType === 'dressing' ? '#1B5E20'
    : '#4A0072';

  const onPickVariant = (next) => {
    if (next.id === sauce.id) return;
    actions.selectVariant(next);
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollBody} showsVerticalScrollIndicator={false}>
        <View style={styles.timingBanner}>
          <View style={styles.timingRow}>
            <Clock size={14} color={COLORS.primary} />
            <Text style={styles.timingTotal}>{meta.label} · ~{sauceTime} min active</Text>
          </View>
          {marineAhead ? (
            <View style={styles.timingRow}>
              <TriangleAlert size={14} color={COLORS.warningText} />
              <Text style={styles.timingNote}>Marinades work best with {sauceTime}+ min ahead.</Text>
            </View>
          ) : null}
          {sauce.cuisine ? (
            <Text style={styles.cuisine}>{sauce.cuisineEmoji ? `${sauce.cuisineEmoji} ` : ''}{sauce.cuisine}</Text>
          ) : null}
        </View>

        {family && family.length > 1 ? (
          <View style={styles.variantWrap}>
            <VariantSwitcher family={family} currentId={sauce.id} onSelect={onPickVariant} />
          </View>
        ) : null}

        <View style={styles.controlsRow}>
          <ServingsControl value={state.servings} onChange={(v) => actions.setServings(v)} />
          <UnitToggle value={state.unitSystem} onChange={(v) => actions.setUnitSystem(v)} />
        </View>

        <View style={styles.section}>
          <View style={[styles.sectionLabel, { backgroundColor: sauceColor }]}>
            <Text style={styles.sectionLabelText}>{meta.label} — {sauce.name}</Text>
          </View>
          {(sauce.steps || []).map((step, i) => (
            <StepCard
              key={`${sauce.id}-${i}`}
              step={step}
              index={i}
              steps={sauce.steps}
              servings={state.servings}
              unitSystem={state.unitSystem}
              disabledIngredients={state.disabledIngredients}
              substitutions={state.substitutions}
            />
          ))}
        </View>

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
  timingBanner: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    ...SHADOWS.sm,
  },
  timingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
  },
  timingTotal: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
    marginLeft: 6,
  },
  timingNote: {
    fontSize: 12,
    color: COLORS.warningText,
    marginLeft: 6,
    flex: 1,
  },
  cuisine: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
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
