// Unified meal recipe — item prep card + sauce step cards. Marinade flow puts
// the sauce section first; everything else puts the item prep first.

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
import HeartButton from '../components/HeartButton';
import { flowMetaFor } from '#shared/constants';
import { COLORS, SHADOWS } from '../theme';

export default function MealRecipeScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const meal = state.meal;
  const item = meal.item;
  const prep = meal.prep;
  const sauce = meal.sauce;

  if (!item || !sauce) {
    return (
      <View style={styles.screen}>
        <EmptyState
          body="Pick an item and sauce first."
          action="Back to home"
          onAction={() => navigation.navigate('MealBuilder')}
        />
      </View>
    );
  }

  const meta = flowMetaFor(item);
  const isMarinade = sauce.sauceType === 'marinade';
  const sauceTime = useMemo(
    () => (sauce.steps || []).reduce((s, st) => s + (st.estimatedTime || 5), 0),
    [sauce.steps],
  );
  const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
  const totalTime = sauceTime + itemCookTime;
  const marineAhead = isMarinade && sauceTime > 20;

  // Item prep card content
  const itemPrepLabel = item.category === 'salad'
    ? `🥗 Toss ${item.name}`
    : `${item.emoji} ${item.category === 'protein' ? 'Cook' : 'Prep'} ${item.name}${prep ? ` — ${prep.name}` : ''}`;
  const itemColor = item.category === 'protein' ? '#C94E02'
    : item.category === 'salad' ? '#2D6A4F'
    : '#1565C0';
  const itemInstructions = prep?.instructions
    || item.instructions
    || (item.category === 'salad'
      ? `Toss ${item.name} with ${sauce.name} right before serving`
      : `Cook ${item.name} per packet instructions`);

  const sauceColor = isMarinade ? '#5D4037'
    : sauce.sauceType === 'dressing' ? '#1B5E20'
    : '#4A0072';
  const sauceLabel = `${meta.sauceWord} — ${sauce.name}`;

  const family = state.selectedSauceFamily;
  const onPickVariant = (next) => {
    if (next.id === sauce.id) return;
    actions.selectVariant(next);
  };

  const itemSection = (
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
          disabledIngredients={state.disabledIngredients}
          substitutions={state.substitutions}
        />
      ))}
    </View>
  );

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scrollBody}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.timingBanner}>
          <View style={styles.timingRow}>
            <Clock size={14} color={COLORS.primary} />
            <Text style={styles.timingTotal}>Total: ~{totalTime} min active</Text>
            {state.currentUser ? (
              <View style={styles.heartSlot}>
                <HeartButton sauceId={sauce.id} size={22} />
              </View>
            ) : null}
          </View>
          {marineAhead ? (
            <View style={styles.timingRow}>
              <TriangleAlert size={14} color={COLORS.warningText} />
              <Text style={styles.timingNote}>Start marinade {sauceTime}+ min before you cook</Text>
            </View>
          ) : null}
        </View>

        {family && family.length > 1 ? (
          <View style={styles.variantWrap}>
            <VariantSwitcher
              family={family}
              currentId={sauce.id}
              onSelect={onPickVariant}
            />
          </View>
        ) : null}

        <View style={styles.controlsRow}>
          <ServingsControl
            value={state.servings}
            onChange={(v) => actions.setServings(v)}
          />
          <UnitToggle
            value={state.unitSystem}
            onChange={(v) => actions.setUnitSystem(v)}
          />
        </View>

        {isMarinade ? (
          <>
            {sauceSection}
            {itemSection}
          </>
        ) : (
          <>
            {itemSection}
            {sauceSection}
          </>
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
  heartSlot: {
    marginLeft: 'auto',
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
