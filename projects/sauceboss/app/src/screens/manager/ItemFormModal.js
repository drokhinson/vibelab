// Add / edit form for a sauceboss_dish row. Used from the Dish tab. Admins
// only — non-admins never see this modal.

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useAppActions } from '../../store/AppContext';
import { COLORS, SHADOWS } from '../../theme';

// Defaults the web uses when the user opens "Add Carb / Protein / Salad".
const PORTION_DEFAULTS = { carb: 100, protein: 150, salad: 80 };
const PORTION_UNIT_DEFAULTS = { carb: 'g', protein: 'g', salad: 'g' };

function blankItem(category, parentId) {
  return {
    category,
    parentId: parentId || null,
    name: '',
    emoji: '',
    description: '',
    sortOrder: 0,
    cookTimeMinutes: '',
    instructions: '',
    waterRatio: '',
    portionPerPerson: String(PORTION_DEFAULTS[category] ?? 100),
    portionUnit: PORTION_UNIT_DEFAULTS[category] ?? 'g',
  };
}

function fromExisting(item) {
  return {
    category: item.category,
    parentId: item.parentId || item.parent_id || null,
    name: item.name || '',
    emoji: item.emoji || '',
    description: item.description || '',
    sortOrder: item.sortOrder ?? item.sort_order ?? 0,
    cookTimeMinutes: item.cookTimeMinutes != null
      ? String(item.cookTimeMinutes)
      : item.cook_time_minutes != null ? String(item.cook_time_minutes) : '',
    instructions: item.instructions || '',
    waterRatio: item.waterRatio || item.water_ratio || '',
    portionPerPerson: item.portionPerPerson != null
      ? String(item.portionPerPerson)
      : item.portion_per_person != null ? String(item.portion_per_person) : '',
    portionUnit: item.portionUnit || item.portion_unit || 'g',
  };
}

export default function ItemFormModal({ visible, mode, category, parentId, parentName, item, onClose }) {
  const actions = useAppActions();
  const [form, setForm] = useState(() => blankItem(category, parentId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!visible) return;
    if (mode === 'edit' && item) setForm(fromExisting(item));
    else setForm(blankItem(category, parentId));
    setError(null);
  }, [visible, mode, item, category, parentId]);

  function patch(updates) {
    setForm((p) => ({ ...p, ...updates }));
  }

  async function handleSubmit() {
    const name = form.name.trim();
    const emoji = form.emoji.trim();
    if (!name || !emoji) {
      setError('Name and emoji are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        category: form.category,
        parentId: form.parentId || null,
        name,
        emoji,
        description: (form.description || '').trim(),
        sortOrder: parseInt(String(form.sortOrder), 10) || 0,
        cookTimeMinutes: form.cookTimeMinutes === '' ? null : parseInt(String(form.cookTimeMinutes), 10) || 0,
        instructions: (form.instructions || '').trim() || null,
        waterRatio: (form.waterRatio || '').trim() || null,
        portionPerPerson: parseFloat(String(form.portionPerPerson)) || PORTION_DEFAULTS[form.category] || 100,
        portionUnit: (form.portionUnit || 'g').trim() || 'g',
      };
      let res;
      if (mode === 'edit' && item) {
        // PATCH only sends changed fields; sending the whole shape is fine
        // because UpdateItemRequest treats every field as Optional.
        res = await actions.updateItem(item.id, payload);
      } else {
        res = await actions.createItem(payload);
      }
      if (!res.ok) {
        setError(res.error || 'Could not save');
      } else {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  const isVariant = !!form.parentId;
  const showCookTime = form.category !== 'salad';
  const showWaterRatio = form.category === 'carb';
  const showInstructions = form.category === 'protein' || isVariant;
  const heading = mode === 'edit'
    ? `Edit ${categoryNoun(form.category, isVariant)}`
    : isVariant
      ? `New variant of ${parentName || categoryNoun(form.category, false)}`
      : `New ${categoryNoun(form.category, false)}`;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.kav}
          >
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
              <TouchableWithoutFeedback>
                <View style={styles.card}>
                  <View style={styles.headerRow}>
                    <Text style={styles.title}>{heading}</Text>
                    <TouchableOpacity onPress={onClose} hitSlop={12}>
                      <X size={20} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={form.name}
                    onChangeText={(v) => patch({ name: v })}
                    placeholder="Jasmine Rice"
                    placeholderTextColor={COLORS.textMuted}
                  />

                  <Text style={styles.label}>Emoji</Text>
                  <TextInput
                    style={styles.input}
                    value={form.emoji}
                    onChangeText={(v) => patch({ emoji: v })}
                    placeholder="🍚"
                    placeholderTextColor={COLORS.textMuted}
                    maxLength={4}
                  />

                  <Text style={styles.label}>Description (optional)</Text>
                  <TextInput
                    style={[styles.input, styles.multi]}
                    value={form.description}
                    onChangeText={(v) => patch({ description: v })}
                    placeholder="Fluffy, fragrant grain"
                    placeholderTextColor={COLORS.textMuted}
                    multiline
                  />

                  <View style={styles.row}>
                    {showCookTime ? (
                      <View style={[styles.col, { marginRight: 8 }]}>
                        <Text style={styles.label}>Cook time (min)</Text>
                        <TextInput
                          style={styles.input}
                          value={form.cookTimeMinutes}
                          onChangeText={(v) => patch({ cookTimeMinutes: v.replace(/[^0-9]/g, '') })}
                          placeholder="10"
                          placeholderTextColor={COLORS.textMuted}
                          keyboardType="number-pad"
                          maxLength={3}
                        />
                      </View>
                    ) : null}
                    <View style={styles.col}>
                      <Text style={styles.label}>Sort order</Text>
                      <TextInput
                        style={styles.input}
                        value={String(form.sortOrder)}
                        onChangeText={(v) => patch({ sortOrder: v.replace(/[^0-9]/g, '') })}
                        placeholder="0"
                        placeholderTextColor={COLORS.textMuted}
                        keyboardType="number-pad"
                        maxLength={3}
                      />
                    </View>
                  </View>

                  <View style={styles.row}>
                    <View style={[styles.col, { marginRight: 8 }]}>
                      <Text style={styles.label}>Portion / person</Text>
                      <TextInput
                        style={styles.input}
                        value={String(form.portionPerPerson)}
                        onChangeText={(v) => patch({ portionPerPerson: v.replace(/[^0-9.]/g, '') })}
                        placeholder="100"
                        placeholderTextColor={COLORS.textMuted}
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <View style={[styles.col, { maxWidth: 88 }]}>
                      <Text style={styles.label}>Unit</Text>
                      <TextInput
                        style={styles.input}
                        value={form.portionUnit}
                        onChangeText={(v) => patch({ portionUnit: v })}
                        placeholder="g"
                        placeholderTextColor={COLORS.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={6}
                      />
                    </View>
                  </View>

                  {showWaterRatio ? (
                    <>
                      <Text style={styles.label}>Water ratio (optional)</Text>
                      <TextInput
                        style={styles.input}
                        value={form.waterRatio}
                        onChangeText={(v) => patch({ waterRatio: v })}
                        placeholder="2:1"
                        placeholderTextColor={COLORS.textMuted}
                        autoCapitalize="none"
                      />
                    </>
                  ) : null}

                  {showInstructions ? (
                    <>
                      <Text style={styles.label}>Detailed Instructions (optional)</Text>
                      <TextInput
                        style={[styles.input, styles.multi]}
                        value={form.instructions}
                        onChangeText={(v) => patch({ instructions: v })}
                        placeholder="Pat dry, season generously…"
                        placeholderTextColor={COLORS.textMuted}
                        multiline
                      />
                    </>
                  ) : null}

                  {error ? <Text style={styles.errorText}>{error}</Text> : null}

                  <TouchableOpacity
                    style={[styles.submit, saving && styles.submitDisabled]}
                    onPress={handleSubmit}
                    disabled={saving}
                    activeOpacity={0.85}
                  >
                    {saving ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.submitLabel}>{mode === 'edit' ? 'Save' : 'Add'}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function categoryNoun(category, isVariant) {
  if (isVariant) return 'variant';
  if (category === 'carb') return 'carb';
  if (category === 'protein') return 'protein';
  if (category === 'salad') return 'salad';
  return 'item';
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  kav: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 22,
    ...SHADOWS.lg,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: COLORS.text, flex: 1 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.4,
    marginBottom: 4,
    marginTop: 8,
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: COLORS.text,
  },
  multi: { minHeight: 60, textAlignVertical: 'top' },
  row: { flexDirection: 'row' },
  col: { flex: 1 },
  errorText: {
    color: COLORS.dangerText,
    backgroundColor: COLORS.danger,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
  },
  submit: {
    marginTop: 16,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.5 },
  submitLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
