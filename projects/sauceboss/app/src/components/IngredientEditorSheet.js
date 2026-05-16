// Ingredient editor — mirrors web's _renderIngEditorSheet (web/builder.js:396-473).
// Drives the builder's "Add Ingredient" / "Edit Ingredient" flow.
//
// Previously built on @gorhom/bottom-sheet's BottomSheetModal — three attempted
// fixes (local provider, drop modal presentation, snapPoints + RAF) still
// failed to make present() reliably surface the sheet in this configuration.
// Swapped to React Native's built-in Modal which behaves predictably: no
// portal, no Reanimated worklet, no provider context required.
//
// Visibility is parent-controlled via `visible`. Draft + onChange/onSave/
// onCancel callbacks unchanged so the parent doesn't need to be touched.

import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { isKnownIngredient, fuzzyMatchIngredients } from '#shared/fuzzy';
import { capitalizeIngredient } from '#shared/text';
import { CATEGORY_ORDER } from '#shared/constants';
import { COLORS } from '../theme';

export default function IngredientEditorSheet({
  visible,
  draft,
  isNew,
  modifiers,
  units,
  qualitativeUnits,
  ingredientCategories,
  onChange,
  onSave,
  onCancel,
  onClassify,
}) {
  const insets = useSafeAreaInsets();
  const isQualitative = qualitativeUnits?.has(draft?.unit);
  const canSave = !!(draft?.name?.trim() && (isQualitative || parseFloat(draft?.amount) > 0));
  const needsCategory =
    !!draft && draft.name.trim().length >= 2 && !isKnownIngredient(draft.name, ingredientCategories);

  // Autocomplete — mirrors web's _renderIngEditorSheet ac dropdown
  // (builder.js:410, fuzzyMatchIngredients). `justPicked` suppresses the
  // dropdown right after the user taps a suggestion; cleared on next keystroke.
  const [justPicked, setJustPicked] = useState(false);
  const acMatches = useMemo(
    () => (draft?.name ? fuzzyMatchIngredients(draft.name, ingredientCategories || {}) : []),
    [draft?.name, ingredientCategories],
  );
  const showAcDropdown = !justPicked && acMatches.length > 0;

  const handleNameChange = (v) => {
    if (justPicked) setJustPicked(false);
    onChange('name', v);
  };
  const handleAcPick = (name) => {
    setJustPicked(true);
    onChange('name', name);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <Pressable style={styles.backdrop} onPress={onCancel} />
        <View style={styles.card}>
          <View style={styles.handle} />
          {draft ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.scrollBody, { paddingBottom: Math.max(28, insets.bottom + 12) }]}
            >
              <View style={styles.header}>
                <Text style={styles.title}>{isNew ? 'Add Ingredient' : 'Edit Ingredient'}</Text>
                <TouchableOpacity onPress={onCancel} hitSlop={10}>
                  <X size={20} color={COLORS.textSecondary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.label}>Ingredient</Text>
              <TextInput
                style={styles.input}
                value={draft.name}
                onChangeText={handleNameChange}
                placeholder="e.g. thyme"
                placeholderTextColor={COLORS.textMuted}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {showAcDropdown ? (
                <View style={styles.acDropdown}>
                  {acMatches.map((name) => (
                    <TouchableOpacity
                      key={name}
                      onPress={() => handleAcPick(name)}
                      style={styles.acItem}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.acItemLabel}>{capitalizeIngredient(name)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              {modifiers && modifiers.length > 0 ? (
                <>
                  <Text style={styles.label}>Prep</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipScroll}
                    keyboardShouldPersistTaps="handled"
                  >
                    <TouchableOpacity
                      onPress={() => onChange('modifier', null)}
                      style={[styles.chip, !draft.modifier && styles.chipActive]}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.chipLabel, !draft.modifier && styles.chipLabelActive]}>
                        no prep
                      </Text>
                    </TouchableOpacity>
                    {modifiers.map((m) => {
                      const label = m.label || m.name;
                      const active = draft.modifier === label;
                      return (
                        <TouchableOpacity
                          key={m.id || label}
                          onPress={() => onChange('modifier', label)}
                          style={[styles.chip, active && styles.chipActive]}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </>
              ) : null}

              <View style={styles.row}>
                <View style={styles.amountCol}>
                  <Text style={styles.label}>Quantity</Text>
                  <TextInput
                    style={[styles.input, isQualitative && styles.inputDisabled]}
                    value={isQualitative ? '' : String(draft.amount || '')}
                    onChangeText={(v) => onChange('amount', v.replace(/[^0-9.]/g, ''))}
                    placeholder={isQualitative ? '—' : 'e.g. 2'}
                    placeholderTextColor={COLORS.textMuted}
                    keyboardType="decimal-pad"
                    editable={!isQualitative}
                  />
                </View>
                <View style={styles.unitCol}>
                  <Text style={styles.label}>Unit</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipScroll}
                    keyboardShouldPersistTaps="handled"
                  >
                    {(units || []).map((u) => {
                      const active = draft.unit === u;
                      return (
                        <TouchableOpacity
                          key={u}
                          onPress={() => onChange('unit', u)}
                          style={[styles.chip, active && styles.chipActive]}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{u}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              </View>

              {needsCategory ? (
                <View style={styles.classifyBlock}>
                  <Text style={styles.classifyLabel}>
                    Classify "{draft.name.trim()}":
                  </Text>
                  <View style={styles.classifyChips}>
                    {CATEGORY_ORDER.map((cat) => (
                      <TouchableOpacity
                        key={cat}
                        onPress={() => onClassify && onClassify(cat)}
                        style={styles.classifyChip}
                        activeOpacity={0.8}
                      >
                        <Text style={styles.classifyChipLabel}>{cat}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ) : null}

              <View style={styles.footer}>
                <TouchableOpacity style={styles.btnSecondary} onPress={onCancel} activeOpacity={0.8}>
                  <Text style={styles.btnSecondaryLabel}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnPrimary, !canSave && styles.btnDisabled]}
                  onPress={onSave}
                  disabled={!canSave}
                  activeOpacity={0.85}
                >
                  <Text style={styles.btnPrimaryLabel}>{isNew ? 'Add' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  // Sheet card now grows up to the full screen height (capped by the
  // KeyboardAvoidingView when the keyboard opens) instead of the previous
  // 85% cap that left a strip of darkened backdrop at the bottom. The
  // ScrollView inside handles its own safe-area padding so content never
  // tucks under the home indicator.
  card: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    flexShrink: 1,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderStrong,
    marginBottom: 6,
  },
  // paddingBottom is set inline at render time so it can incorporate the
  // safe-area bottom inset and never tuck content under the home indicator.
  scrollBody: {
    paddingHorizontal: 18,
    paddingTop: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.3,
    marginTop: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.text,
  },
  inputDisabled: {
    opacity: 0.4,
  },
  acDropdown: {
    marginTop: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderTopWidth: 2,
    borderTopColor: COLORS.primary,
    backgroundColor: COLORS.background,
    overflow: 'hidden',
  },
  acItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  acItemLabel: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  amountCol: {
    width: 96,
  },
  unitCol: {
    flex: 1,
    minWidth: 0,
  },
  chipScroll: {
    paddingVertical: 4,
    gap: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    marginRight: 6,
  },
  chipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  chipLabelActive: {
    color: '#fff',
  },
  classifyBlock: {
    marginTop: 14,
    padding: 10,
    backgroundColor: COLORS.highlightTint,
    borderRadius: 10,
  },
  classifyLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primaryDark,
    marginBottom: 6,
  },
  classifyChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  classifyChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  classifyChipLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  btnSecondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
  },
  btnSecondaryLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
  },
  btnPrimaryLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#fff',
  },
  btnDisabled: {
    opacity: 0.45,
  },
});
