// Wizard step 5 — Review. Read-only summary of the recipe with per-section
// Edit pills that jump back to the relevant step (with returnToReview=true
// so Continue returns here). Steps and Pairing are accordion sections that
// collapse the per-step detail into a one-line summary by default —
// mirrors web's renderBuilderReview (web/builder.js:630-714).

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Pencil, CornerDownRight, Save, ChevronRight } from 'lucide-react-native';
import { SAUCE_TYPES } from '#shared/constants';
import { capitalizeIngredient } from '#shared/text';
import builderStyles from './builderStyles';
import { COLORS } from '../../theme';

function AccordionSection({ title, summary, expanded, onToggle, onEdit, editable, children }) {
  return (
    <View style={builderStyles.card}>
      <TouchableOpacity
        onPress={onToggle}
        activeOpacity={0.7}
        style={localStyles.accordionHeader}
      >
        <View style={[localStyles.chevron, expanded && localStyles.chevronOpen]}>
          <ChevronRight size={14} color={COLORS.textSecondary} />
        </View>
        <Text style={builderStyles.sectionLabel}>{title}</Text>
        <Text style={localStyles.accordionSummary} numberOfLines={1}>
          {summary}
        </Text>
        {editable && onEdit ? (
          <TouchableOpacity style={builderStyles.editPill} onPress={onEdit} activeOpacity={0.8}>
            <Pencil size={12} color={COLORS.primary} />
            <Text style={builderStyles.editPillLabel}>Edit</Text>
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
      {expanded ? <View style={localStyles.accordionBody}>{children}</View> : null}
    </View>
  );
}

export default function ReviewStep({
  builder,
  items,
  editingId,
  saving,
  saveError,
  qualitativeUnits,
  isStandalone,
  onEditInfo,
  onEditInstructions,
  onEditPairing,
  onConfirm,
  onDiscard,
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);

  const typeMeta = SAUCE_TYPES.find((t) => t.value === builder.sauceType) || SAUCE_TYPES[0];
  const allItemsFlat = [
    ...(items.carbs || []),
    ...(items.proteins || []),
    ...(items.salads || []),
  ];
  const pairedItems = builder.itemIds
    .map((id) => allItemsFlat.find((it) => it.id === id))
    .filter(Boolean);
  const totalTime = builder.steps.reduce((sum, s) => {
    const t = parseInt((s.estimatedTime ?? '').toString(), 10);
    return sum + (Number.isFinite(t) && t > 0 ? t : 5);
  }, 0);
  const totalIngs = builder.steps.reduce(
    (sum, s) => sum + (s.ingredients || []).filter((i) => i.name && i.name.trim()).length,
    0,
  );

  // Mirrors web's source-label map (builder.js:647). Falls back to the
  // sourceUrl-derived heuristic for builders that pre-date the recipeSource
  // field (e.g. an edit of a sauce saved before this change).
  const SOURCE_LABELS = {
    url: '🌐 Imported from website',
    reel: '📱 Imported from reel',
    file: '📄 Imported from file',
    manual: '✍️ Manual entry',
  };
  const sourceLabel = SOURCE_LABELS[builder.recipeSource]
    || (builder.sourceUrl ? '🌐 Imported from website' : '✍️ Manual entry');

  const stepCount = builder.steps.length;
  const stepsSummary = `${stepCount} step${stepCount === 1 ? '' : 's'} · ${totalIngs} ingredient${totalIngs === 1 ? '' : 's'}`;
  const pairingSummary = isStandalone
    ? typeMeta.label
    : `${typeMeta.label}${pairedItems.length > 0 ? ' · ' + pairedItems.map((p) => `${p.emoji || ''} ${p.name}`).join(', ') : ' · None'}`;

  return (
    <>
      {/* Source bubble — mirrors web's `.review-info-bubble`. */}
      <View style={builderStyles.reviewSourceBubble}>
        <Text style={builderStyles.reviewSourceLabel}>{sourceLabel}</Text>
        {builder.sourceUrl ? (
          <Text style={builderStyles.reviewSourceUrl} numberOfLines={1}>
            {builder.sourceUrl}
          </Text>
        ) : null}
      </View>

      {/* Summary card — Edit jumps to Info step. */}
      <View style={builderStyles.card}>
        <View style={builderStyles.reviewHeader}>
          <View style={[builderStyles.reviewSwatch, { backgroundColor: builder.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={builderStyles.reviewName} numberOfLines={2}>
              {builder.name}
            </Text>
            <Text style={builderStyles.reviewMeta}>
              {typeMeta.label}
              {builder.cuisine
                ? ` · ${builder.cuisineEmoji ? `${builder.cuisineEmoji} ` : ''}${builder.cuisine}`
                : ''}
            </Text>
          </View>
          <TouchableOpacity style={builderStyles.editPill} onPress={onEditInfo} activeOpacity={0.8}>
            <Pencil size={12} color={COLORS.primary} />
            <Text style={builderStyles.editPillLabel}>Edit</Text>
          </TouchableOpacity>
        </View>
        {builder.description ? (
          <Text style={builderStyles.reviewDescription}>{builder.description}</Text>
        ) : null}
        <View style={builderStyles.reviewMetaRow}>
          <Text style={builderStyles.reviewMetaLabel}>
            ~{totalTime} min · {stepCount} step{stepCount === 1 ? '' : 's'}
          </Text>
        </View>
      </View>

      {/* Recipe Steps accordion */}
      <AccordionSection
        title="Recipe Steps"
        summary={stepsSummary}
        expanded={stepsOpen}
        onToggle={() => setStepsOpen((v) => !v)}
        onEdit={onEditInstructions}
        editable
      >
        {builder.steps.map((step, idx) => {
          const stepTime = (() => {
            const t = parseInt((step.estimatedTime ?? '').toString(), 10);
            return Number.isFinite(t) && t > 0 ? t : 5;
          })();
          const visibleIngs = step.ingredients.filter((i) => i.name && i.name.trim());
          return (
            <View key={idx} style={localStyles.stepCard}>
              <View style={builderStyles.reviewStepHeader}>
                <Text style={builderStyles.reviewStepNumber}>STEP {idx + 1}</Text>
                <Text style={builderStyles.reviewStepTime}>~{stepTime}m</Text>
              </View>
              {step.title ? (
                <Text style={builderStyles.reviewStepTitle}>{step.title}</Text>
              ) : null}
              {(step.inputFromSteps || []).length > 0 ? (
                <View style={builderStyles.refBadge}>
                  <CornerDownRight size={12} color={COLORS.primaryDark} />
                  <Text style={builderStyles.refBadgeText}>
                    Combines{' '}
                    {(step.inputFromSteps || []).map((r) => `Step ${r}`).join(', ')}{' '}
                    into this bowl
                  </Text>
                </View>
              ) : null}
              {step.instructions ? (
                <Text style={builderStyles.reviewStepInstructions}>{step.instructions}</Text>
              ) : null}
              {visibleIngs.length > 0 ? (
                <View style={builderStyles.reviewIngList}>
                  {visibleIngs.map((ing, ii) => (
                    <View key={ii} style={builderStyles.reviewIngRow}>
                      <Text style={builderStyles.reviewIngName} numberOfLines={1}>
                        {ing.modifier ? `${capitalizeIngredient(ing.modifier)} ` : ''}
                        {capitalizeIngredient(ing.name)}
                      </Text>
                      <Text style={builderStyles.reviewIngQty}>
                        {qualitativeUnits?.has(ing.unit) || !ing.amount
                          ? ing.unit
                          : `${ing.amount} ${ing.unit}`}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </AccordionSection>

      {/* Dish Pairing accordion */}
      <AccordionSection
        title="Dish Pairing"
        summary={pairingSummary}
        expanded={pairingOpen}
        onToggle={() => setPairingOpen((v) => !v)}
        onEdit={onEditPairing}
        editable={!isStandalone}
      >
        <Text style={builderStyles.reviewField}>
          <Text style={localStyles.fieldLabel}>Type: </Text>
          {typeMeta.label}
        </Text>
        {isStandalone ? (
          <Text style={builderStyles.reviewField}>Standalone recipe — no dish pairing.</Text>
        ) : (
          <Text style={builderStyles.reviewField}>
            <Text style={localStyles.fieldLabel}>Pairs with: </Text>
            {pairedItems.length === 0
              ? 'None'
              : pairedItems.map((c) => `${c.emoji || ''} ${c.name}`).join(', ')}
          </Text>
        )}
      </AccordionSection>

      {/* Confirm */}
      <View style={builderStyles.card}>
        {saveError ? <Text style={builderStyles.error}>{saveError}</Text> : null}
        <TouchableOpacity
          style={[builderStyles.saveBtn, saving && builderStyles.btnDisabled]}
          onPress={onConfirm}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Save size={16} color="#fff" />
              <Text style={builderStyles.saveBtnLabel}>
                {editingId ? 'Save Changes' : 'Create Sauce'}
              </Text>
            </>
          )}
        </TouchableOpacity>
        {onDiscard ? (
          <TouchableOpacity
            style={localStyles.discardBtn}
            onPress={onDiscard}
            activeOpacity={0.7}
          >
            <Text style={localStyles.discardLabel}>Discard</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );
}

const localStyles = StyleSheet.create({
  discardBtn: {
    marginTop: 12,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 999,
    backgroundColor: '#E5E7EB',
  },
  discardLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chevron: {
    width: 18,
    alignItems: 'center',
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  accordionSummary: {
    flex: 1,
    fontSize: 12,
    color: COLORS.textMuted,
    marginLeft: 4,
  },
  accordionBody: {
    marginTop: 8,
  },
  stepCard: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  fieldLabel: {
    fontWeight: '800',
    color: COLORS.text,
  },
});
