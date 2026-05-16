// Wizard step 3 — Instructions. Per-step cards with title, time,
// collapsible detailed instructions, ingredient chips, combine chip,
// action pills, and an unassigned-ingredients tray from imports.
// Mirrors web's renderBuilderInstructions (web/builder.js:240-554).
//
// `addStep(at)` accepts an insertion index — the dashed dividers between
// (and after) every step call it with their position, matching web's
// `.insert-step-divider` UX.

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import {
  Plus,
  Trash2,
  Pencil,
  X,
  CornerDownRight,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react-native';
import { isKnownIngredient } from '#shared/fuzzy';
import { capitalizeIngredient } from '#shared/text';
import builderStyles from './builderStyles';
import { COLORS } from '../../theme';

// Four warm tones — none white — so step 1 reads as a card on the screen
// background instead of dissolving into it. Mirrors web's data-shade=0..3.
const STEP_SHADES = [
  { backgroundColor: '#FFF8F0' },
  { backgroundColor: '#F8F5F0' },
  { backgroundColor: '#F1ECE3' },
  { backgroundColor: '#EAE3D6' },
];

function InsertStepDivider({ onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.insertWrap}
      activeOpacity={0.7}
      accessibilityLabel="Insert step here"
    >
      <View style={styles.insertLine} />
      <View style={styles.insertPlus}>
        <Plus size={14} color={COLORS.primary} />
      </View>
      <View style={styles.insertLine} />
    </TouchableOpacity>
  );
}

function StepCard({
  step,
  idx,
  totalSteps,
  qualitativeUnits,
  ingredientCategories,
  patchStep,
  removeStep,
  openIngAdd,
  openIngEdit,
  removeIngredient,
  openStepInputEditor,
  clearStepInput,
}) {
  const [showInstructions, setShowInstructions] = useState(!!step.instructions);
  return (
    <View style={[builderStyles.stepBox, STEP_SHADES[idx % STEP_SHADES.length]]}>
      <View style={builderStyles.stepHeader}>
        <Text style={builderStyles.stepNumber}>Step {idx + 1}</Text>
        {totalSteps > 1 ? (
          <TouchableOpacity
            onPress={() => removeStep(idx)}
            hitSlop={8}
            style={builderStyles.removeStep}
          >
            <Trash2 size={14} color={COLORS.dangerText} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={builderStyles.titleRow}>
        <View style={builderStyles.titleCol}>
          <Text style={builderStyles.label}>Title</Text>
          <TextInput
            style={builderStyles.input}
            value={step.title}
            onChangeText={(v) => patchStep(idx, { title: v })}
            placeholder="Whisk everything together"
            placeholderTextColor={COLORS.textMuted}
          />
        </View>
        <View style={builderStyles.timeCol}>
          <Text style={builderStyles.label}>Time</Text>
          <View style={builderStyles.timeWrap}>
            <TextInput
              style={builderStyles.timeInput}
              value={step.estimatedTime ?? ''}
              onChangeText={(v) =>
                patchStep(idx, { estimatedTime: v.replace(/[^0-9]/g, '') })
              }
              placeholder="5"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Text style={builderStyles.timeSuffix}>min</Text>
          </View>
        </View>
      </View>

      <TouchableOpacity
        style={styles.instructionsToggle}
        onPress={() => setShowInstructions((v) => !v)}
        activeOpacity={0.7}
      >
        {showInstructions ? (
          <ChevronUp size={14} color={COLORS.primary} />
        ) : (
          <ChevronDown size={14} color={COLORS.primary} />
        )}
        <Text style={styles.instructionsToggleLabel}>
          {showInstructions ? 'Hide detailed instructions' : 'Detailed instructions (Optional)'}
        </Text>
      </TouchableOpacity>
      {showInstructions ? (
        <TextInput
          style={[builderStyles.input, builderStyles.multiline]}
          value={step.instructions}
          onChangeText={(v) => patchStep(idx, { instructions: v })}
          placeholder="In a small bowl, combine the ingredients and whisk until smooth."
          placeholderTextColor={COLORS.textMuted}
          multiline
        />
      ) : null}

      <Text style={[builderStyles.label, { marginTop: 12 }]}>Ingredients</Text>
      {(step.inputFromSteps || []).length > 0 ? (
        <View style={builderStyles.combineChip}>
          <CornerDownRight size={14} color={COLORS.primaryDark} />
          <Text style={builderStyles.combineChipLabel} numberOfLines={2}>
            Combines{' '}
            {(step.inputFromSteps || []).map((r) => `Step ${r}`).join(', ')}
          </Text>
          <TouchableOpacity
            onPress={() => openStepInputEditor(idx)}
            hitSlop={8}
            style={builderStyles.combineChipBtn}
          >
            <Pencil size={14} color={COLORS.primaryDark} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => clearStepInput(idx)}
            hitSlop={8}
            style={builderStyles.combineChipBtn}
          >
            <X size={14} color={COLORS.dangerText} />
          </TouchableOpacity>
        </View>
      ) : null}
      {step.ingredients.length === 0 ? (
        <Text style={builderStyles.ingEmpty}>
          No ingredients yet — tap below to add one.
        </Text>
      ) : (
        step.ingredients.map((ing, ingIdx) => {
          const isQual = qualitativeUnits.has(ing.unit);
          const incomplete =
            !ing.name || (!isQual && !(parseFloat(ing.amount) > 0));
          // Flag imported / hand-entered ingredients we haven't seen in the
          // categories table yet — same check IngredientEditorSheet uses to
          // decide whether to surface the "Classify…" prompt.
          const isNew =
            !!ing.name &&
            ing.name.trim().length >= 2 &&
            !isKnownIngredient(ing.name, ingredientCategories);
          return (
            <TouchableOpacity
              key={ingIdx}
              onPress={() => openIngEdit(idx, ingIdx)}
              style={[builderStyles.ingChip, incomplete && builderStyles.ingChipIncomplete]}
              activeOpacity={0.7}
            >
              <View style={builderStyles.ingChipBody}>
                <View style={styles.nameRow}>
                  <Text style={builderStyles.ingChipName} numberOfLines={1}>
                    {ing.modifier ? `${capitalizeIngredient(ing.modifier)} ` : ''}
                    {ing.name ? capitalizeIngredient(ing.name) : 'Untitled'}
                  </Text>
                  {isNew ? (
                    <View style={styles.newPill}>
                      <Text style={styles.newPillLabel}>NEW</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={builderStyles.ingChipQty}>
                  {isQual ? ing.unit : `${ing.amount || '0'} ${ing.unit}`}
                </Text>
              </View>
              <View style={builderStyles.ingChipActions}>
                <Pencil size={14} color={COLORS.textSecondary} />
                <TouchableOpacity
                  onPress={() => removeIngredient(idx, ingIdx)}
                  hitSlop={8}
                  style={builderStyles.ingChipRemove}
                >
                  <X size={14} color={COLORS.dangerText} />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          );
        })
      )}
      <View style={builderStyles.stepActionPills}>
        <TouchableOpacity
          onPress={() => openIngAdd(idx)}
          style={builderStyles.addIngPill}
          activeOpacity={0.7}
        >
          <Plus size={14} color={COLORS.primary} />
          <Text style={builderStyles.addIngPillLabel}>Add Ingredient</Text>
        </TouchableOpacity>
        {idx > 0 ? (
          <TouchableOpacity
            onPress={() => openStepInputEditor(idx)}
            style={builderStyles.addIngPill}
            activeOpacity={0.7}
          >
            <Plus size={14} color={COLORS.primary} />
            <Text style={builderStyles.addIngPillLabel}>Previous Step</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

export default function InstructionsStep({
  builder,
  qualitativeUnits,
  ingredientCategories,
  patchStep,
  addStep,
  removeStep,
  openIngAdd,
  openIngEdit,
  removeIngredient,
  openStepInputEditor,
  clearStepInput,
  moveUnassignedToStep,
  deleteUnassigned,
}) {
  return (
    <>
      <View style={builderStyles.card}>
        {builder.steps.map((step, idx) => (
          <React.Fragment key={idx}>
            <StepCard
              step={step}
              idx={idx}
              totalSteps={builder.steps.length}
              qualitativeUnits={qualitativeUnits}
              ingredientCategories={ingredientCategories}
              patchStep={patchStep}
              removeStep={removeStep}
              openIngAdd={openIngAdd}
              openIngEdit={openIngEdit}
              removeIngredient={removeIngredient}
              openStepInputEditor={openStepInputEditor}
              clearStepInput={clearStepInput}
            />
            {/* Divider after every step (including the last). idx+1 = insert
                position in the steps array; tapping after step N inserts a
                new step at index N+1 so it becomes "Step N+1". */}
            <InsertStepDivider onPress={() => addStep(idx + 1)} />
          </React.Fragment>
        ))}
      </View>

      {/* Unassigned ingredients (from URL import) */}
      {builder.unassignedIngredients.length > 0 ? (
        <View style={[builderStyles.card, { borderColor: COLORS.warningText, borderWidth: 1 }]}>
          <View style={builderStyles.sectionRow}>
            <Text style={builderStyles.sectionLabel}>
              ⚠ Unassigned ingredients ({builder.unassignedIngredients.length})
            </Text>
          </View>
          <Text style={builderStyles.help}>
            These came from the import but couldn't be matched to a step. Tap a step
            to move an ingredient into it, or × to delete. The recipe can't save
            while this list is non-empty.
          </Text>
          {builder.unassignedIngredients.map((u, i) => {
            const isNew = !!u.name && u.name.trim().length >= 2 &&
              !isKnownIngredient(u.name, ingredientCategories);
            return (
            <View key={i} style={builderStyles.unassignedCard}>
              <View style={builderStyles.unassignedHeader}>
                <Text style={builderStyles.unassignedName} numberOfLines={1}>
                  {capitalizeIngredient(u.name)}
                </Text>
                {isNew ? (
                  <View style={styles.newPill}>
                    <Text style={styles.newPillLabel}>NEW</Text>
                  </View>
                ) : null}
                {u.amount ? (
                  <Text style={builderStyles.unassignedQty}>
                    {u.amount}
                    {u.unit ? ` ${u.unit}` : ''}
                  </Text>
                ) : null}
                <TouchableOpacity
                  onPress={() => deleteUnassigned(i)}
                  hitSlop={6}
                  style={builderStyles.unassignedDelete}
                >
                  <X size={14} color={COLORS.dangerText} />
                </TouchableOpacity>
              </View>
              <View style={builderStyles.unassignedTargets}>
                <ArrowRight size={12} color={COLORS.textSecondary} />
                {builder.steps.map((s, si) => {
                  const tail = s.title ? ` — ${s.title.slice(0, 14)}` : '';
                  return (
                    <TouchableOpacity
                      key={si}
                      onPress={() => moveUnassignedToStep(i, si)}
                      style={builderStyles.targetPill}
                      activeOpacity={0.8}
                    >
                      <Text style={builderStyles.targetPillLabel}>
                        Step {si + 1}
                        {tail}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  newPill: {
    backgroundColor: COLORS.warning || '#FED7AA',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  newPillLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#9A3412',
    letterSpacing: 0.6,
  },
  insertWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 6,
  },
  insertLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  insertPlus: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instructionsToggle: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  instructionsToggleLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
  },
});
