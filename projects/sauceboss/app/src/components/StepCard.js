// One step in a recipe — header, instructions, pie chart, legend. Replaces the
// step rendering that PieChart was doing inline so RecipeScreen can compose
// it with reference-step badges, instructions toggle, and substitution hints.

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CornerDownRight, ChevronDown } from 'lucide-react-native';
import { prepareItems, cumulativeStepTsp, tspToDisplay, ingColor, formatAmount } from '#shared';
import PieChart from './PieChart';
import { COLORS } from '../theme';

export default function StepCard({
  step,
  index,
  steps,
  servings,
  unitSystem,
  baseServings,
  disabledIngredients,
  substitutions,
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  const stepTime = step.estimatedTime || 5;

  const displayItems = prepareItems(step.ingredients, { servings, unitSystem, baseServings });

  // Reference step (combined input) — prepend a synthetic slice for it.
  const refStep = step.inputFromStep ? steps[step.inputFromStep - 1] : null;
  if (refStep) {
    const refTsp = cumulativeStepTsp(steps, step.inputFromStep - 1, servings, baseServings);
    const disp = tspToDisplay(refTsp);
    displayItems.unshift({
      name: `Step ${step.inputFromStep} combined`,
      amount: disp.amount,
      unit: disp.unit,
    });
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.stepNumber}>Step {index + 1}</Text>
        <Text style={styles.stepTime}>~{stepTime}m</Text>
      </View>
      <Text style={styles.stepTitle}>{step.title}</Text>

      {step.instructions ? (
        <TouchableOpacity
          onPress={() => setShowInstructions((v) => !v)}
          activeOpacity={0.7}
          style={styles.instructionsToggle}
        >
          <Text style={styles.instructionsToggleLabel}>
            {showInstructions ? 'Hide instructions' : 'Show instructions'}
          </Text>
          <ChevronDown
            size={14}
            color={COLORS.textSecondary}
            style={{ transform: [{ rotate: showInstructions ? '180deg' : '0deg' }] }}
          />
        </TouchableOpacity>
      ) : null}
      {showInstructions && step.instructions ? (
        <Text style={styles.instructionsBody}>{step.instructions}</Text>
      ) : null}

      {refStep ? (
        <View style={styles.refBadge}>
          <CornerDownRight size={14} color={COLORS.primary} />
          <Text style={styles.refBadgeText}>
            Combine all of Step {step.inputFromStep} into this bowl
          </Text>
        </View>
      ) : null}

      <View style={styles.viz}>
        <View style={styles.chartWrap}>
          <PieChart items={displayItems} size={110} />
        </View>
        <View style={styles.legend}>
          {displayItems.map((it, i) => {
            const color = ingColor(it.name, i);
            const isDisabled = disabledIngredients?.has(it.name);
            const sub = isDisabled && substitutions ? subFor(it.name, substitutions) : '';
            const isQualitative = it.unit === 'to taste';
            return (
              <View key={`${it.name}-${i}`} style={styles.legendRow}>
                <View style={[styles.swatch, { backgroundColor: color }]} />
                <View style={styles.legendNameWrap}>
                  <Text style={[styles.legendName, isDisabled && styles.legendNameDisabled]} numberOfLines={1}>
                    {it.name}
                  </Text>
                  {sub ? <Text style={styles.subHint}>try {sub}</Text> : null}
                </View>
                <Text style={[styles.legendAmount, isQualitative && styles.legendAmountQual]}>
                  {isQualitative ? 'to taste' : `${formatAmount(it.amount)} ${it.unit}`}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function subFor(name, substitutions) {
  const subs = substitutions[name];
  if (!subs || subs.length === 0) return '';
  const first = subs[0];
  return typeof first === 'string' ? first : (first.substituteName || '');
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 0.5,
  },
  stepTime: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
  },
  instructionsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  instructionsToggleLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginRight: 4,
  },
  instructionsBody: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 4,
    marginBottom: 6,
    lineHeight: 18,
  },
  refBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: COLORS.highlightTint,
    borderRadius: 8,
    marginVertical: 6,
  },
  refBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.primaryDark,
    marginLeft: 6,
    flex: 1,
  },
  viz: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  chartWrap: {
    width: 110,
    height: 110,
    marginRight: 12,
    flexShrink: 0,
  },
  legend: {
    flex: 1,
    paddingLeft: 4,
    paddingTop: 0,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
    marginRight: 10,
  },
  legendNameWrap: {
    flex: 1,
  },
  legendName: {
    fontSize: 13,
    fontWeight: '500',
    color: COLORS.text,
  },
  legendNameDisabled: {
    color: COLORS.textMuted,
    textDecorationLine: 'line-through',
  },
  subHint: {
    fontSize: 11,
    color: COLORS.warningText,
    fontStyle: 'italic',
  },
  legendAmount: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginLeft: 8,
  },
  legendAmountQual: {
    fontStyle: 'italic',
    color: COLORS.textMuted,
  },
});
