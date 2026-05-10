// Add / edit form for a sauceboss_ingredient row. Used from the Ingredients tab.
// Add: any logged-in user. Edit: admin only (but the modal itself is the same).
//
// Mirrors the web's renderIngredientForm: name + plural + category picker +
// substitutions list. Existing categories are pulled from
// `state.ingredientCategories`; "+ New category…" expands a draft input.
// Saving the form calls createIngredient / updateIngredient with the full
// payload (name, plural, category, substitutions).

import React, { useEffect, useMemo, useState } from 'react';
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
import { useAppActions, useAppState } from '../../store/AppContext';
import { CATEGORY_ORDER } from '#shared/constants';
import { COLORS, SHADOWS } from '../../theme';

const NEW_CATEGORY = '__new__';

export default function IngredientFormModal({ visible, mode, ingredient, onClose }) {
  const state = useAppState();
  const actions = useAppActions();

  const [name, setName] = useState('');
  const [plural, setPlural] = useState('');
  const [category, setCategory] = useState('');           // '' | category | NEW_CATEGORY
  const [categoryDraft, setCategoryDraft] = useState(''); // populated when category === NEW_CATEGORY
  const [substitutionsText, setSubstitutionsText] = useState(''); // comma-separated
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Compose the picker options: shared CATEGORY_ORDER first, then any user-
  // defined categories present in state, sorted alphabetically. Mirrors
  // renderIngredientForm in web/settings.js.
  const allCategories = useMemo(() => {
    const userCats = new Set(Object.values(state.ingredientCategories || {}));
    for (const c of CATEGORY_ORDER) userCats.delete(c);
    const extras = [...userCats].filter(Boolean).sort((a, b) => a.localeCompare(b));
    return [...CATEGORY_ORDER, ...extras];
  }, [state.ingredientCategories]);

  useEffect(() => {
    if (!visible) return;
    if (mode === 'edit' && ingredient) {
      setName(ingredient.name || '');
      setPlural(ingredient.plural || '');
      // Prefer the row's own category; fall back to the legacy mapping in state.
      const fallback = state.ingredientCategories?.[(ingredient.name || '').toLowerCase()] || '';
      setCategory(ingredient.category || fallback || '');
      const subs = Array.isArray(ingredient.substitutions) ? ingredient.substitutions : [];
      setSubstitutionsText(subs.join(', '));
    } else {
      setName('');
      setPlural('');
      setCategory('');
      setSubstitutionsText('');
    }
    setCategoryDraft('');
    setError(null);
  }, [visible, mode, ingredient, state.ingredientCategories]);

  async function handleSubmit() {
    const n = name.trim();
    if (!n) {
      setError('Name is required.');
      return;
    }
    let resolvedCategory = category;
    if (resolvedCategory === NEW_CATEGORY) {
      resolvedCategory = categoryDraft.trim();
      if (!resolvedCategory) {
        setError('New category name is required.');
        return;
      }
    }
    if (mode === 'add' && !resolvedCategory) {
      setError('Category is required.');
      return;
    }

    const substitutions = substitutionsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: n,
        plural: plural.trim() || null,
        category: resolvedCategory || null,
        substitutions,
      };
      const res = mode === 'edit' && ingredient
        ? await actions.updateIngredient(ingredient.id, payload)
        : await actions.createIngredient(payload);
      if (!res.ok) {
        setError(res.error || 'Could not save');
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

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
                    <Text style={styles.title}>
                      {mode === 'edit' ? 'Edit ingredient' : 'New ingredient'}
                    </Text>
                    <TouchableOpacity onPress={onClose} hitSlop={12}>
                      <X size={20} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.label}>Category</Text>
                  <View style={styles.categoryRow}>
                    {allCategories.map((c) => {
                      const active = category === c;
                      return (
                        <TouchableOpacity
                          key={c}
                          onPress={() => {
                            setCategory(c);
                            setCategoryDraft('');
                          }}
                          style={[styles.pill, active && styles.pillActive]}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>{c}</Text>
                        </TouchableOpacity>
                      );
                    })}
                    <TouchableOpacity
                      onPress={() => setCategory(NEW_CATEGORY)}
                      style={[styles.pill, category === NEW_CATEGORY && styles.pillActive]}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.pillLabel, category === NEW_CATEGORY && styles.pillLabelActive]}>
                        + New category…
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {category === NEW_CATEGORY ? (
                    <TextInput
                      style={[styles.input, { marginTop: 8 }]}
                      value={categoryDraft}
                      onChangeText={setCategoryDraft}
                      placeholder="New category name"
                      placeholderTextColor={COLORS.textMuted}
                      autoCapitalize="words"
                    />
                  ) : null}

                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="tomato"
                    placeholderTextColor={COLORS.textMuted}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />

                  <Text style={styles.label}>Plural (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={plural}
                    onChangeText={setPlural}
                    placeholder="tomatoes"
                    placeholderTextColor={COLORS.textMuted}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />

                  <Text style={styles.label}>Substitutions (optional, comma-separated)</Text>
                  <TextInput
                    style={styles.input}
                    value={substitutionsText}
                    onChangeText={setSubstitutionsText}
                    placeholder="canned tomato, sun-dried tomato"
                    placeholderTextColor={COLORS.textMuted}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />

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

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  kav: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  card: { backgroundColor: COLORS.card, borderRadius: 18, padding: 22, ...SHADOWS.lg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: COLORS.text },
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
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  pillActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  pillLabel: { fontSize: 12, fontWeight: '700', color: COLORS.textSecondary },
  pillLabelActive: { color: '#fff' },
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
