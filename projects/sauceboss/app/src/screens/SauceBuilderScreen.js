// SauceBuilderScreen — single-screen form for creating or editing a sauce.
// Uses #shared/validation.validateBuilder so the rules match the web app.
// Authoring scope (per the plan): authoring + URL import. Bulk admin (item
// management, food merge) stays on web.

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  Plus,
  Minus,
  Trash2,
  Link2,
  Save,
  X,
} from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import { api } from '../api/client';
import { CUISINES, UNITS, COLOR_SWATCHES, SAUCE_TYPES } from '#shared/constants';
import { validateBuilder } from '#shared/validation';
import { applyParsedRecipe } from '#shared/builder';
import FoodAutocomplete from '../components/FoodAutocomplete';
import EmptyState from '../components/EmptyState';
import { COLORS, SHADOWS } from '../theme';

function emptyStep() {
  return {
    title: '',
    instructions: '',
    inputFromStep: null,
    ingredients: [{ name: '', amount: '', unit: 'tsp' }],
  };
}

function emptyBuilder() {
  return {
    name: '',
    cuisine: '',
    cuisineEmoji: '',
    color: COLOR_SWATCHES[0],
    description: '',
    sourceUrl: '',
    sauceType: 'sauce',
    parentSauceId: null,
    itemIds: [],
    steps: [emptyStep()],
    unassignedIngredients: [],
  };
}

function builderFromSauce(sauce) {
  return {
    name: sauce.name || '',
    cuisine: sauce.cuisine || '',
    cuisineEmoji: sauce.cuisineEmoji || '',
    color: sauce.color || COLOR_SWATCHES[0],
    description: sauce.description || '',
    sourceUrl: sauce.sourceUrl || '',
    sauceType: sauce.sauceType || 'sauce',
    parentSauceId: sauce.parentSauceId || null,
    itemIds: (sauce.compatibleItemIds || sauce.itemIds || []).slice(),
    steps: (sauce.steps || []).map((s) => ({
      title: s.title || '',
      instructions: s.instructions || '',
      inputFromStep: s.inputFromStep || null,
      ingredients: (s.ingredients || []).map((i) => ({
        name: i.name || '',
        amount: i.amount != null ? String(i.amount) : '',
        unit: i.unit || 'tsp',
      })),
    })),
    unassignedIngredients: [],
  };
}

export default function SauceBuilderScreen({ navigation, route }) {
  const state = useAppState();
  const actions = useAppActions();
  const insets = useSafeAreaInsets();
  const editingId = route?.params?.sauceId || null;

  const [builder, setBuilder] = useState(emptyBuilder);
  const [loadingExisting, setLoadingExisting] = useState(!!editingId);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Items list — for the "pair with" picker. Backend's /items returns
  // {carbs, proteins, salads}. We flatten parents only (variants get linked
  // implicitly through their parent).
  const [items, setItems] = useState({ carbs: [], proteins: [], salads: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const itemsResp = await api.allItems();
        if (!cancelled) setItems(itemsResp);
      } catch {
        // ignore — pairing UI just shows empty groups
      }

      if (editingId) {
        // Find the sauce in the manager-loaded list, or fetch fresh
        let sauce = state.managerSauces.find((s) => s.id === editingId);
        if (!sauce) {
          try {
            const all = await api.allSauces();
            sauce = all.find((s) => s.id === editingId);
          } catch {
            // ignore
          }
        }
        if (!cancelled && sauce) {
          setBuilder(builderFromSauce(sauce));
        }
        if (!cancelled) setLoadingExisting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const validation = useMemo(() => validateBuilder(builder), [builder]);

  function patch(updates) {
    setBuilder((prev) => ({ ...prev, ...updates }));
  }

  function patchStep(idx, updates) {
    setBuilder((prev) => {
      const next = prev.steps.slice();
      next[idx] = { ...next[idx], ...updates };
      return { ...prev, steps: next };
    });
  }

  function patchIng(stepIdx, ingIdx, updates) {
    setBuilder((prev) => {
      const next = prev.steps.slice();
      const ings = next[stepIdx].ingredients.slice();
      ings[ingIdx] = { ...ings[ingIdx], ...updates };
      next[stepIdx] = { ...next[stepIdx], ingredients: ings };
      return { ...prev, steps: next };
    });
  }

  function addStep() {
    setBuilder((prev) => ({ ...prev, steps: [...prev.steps, emptyStep()] }));
  }

  function removeStep(idx) {
    setBuilder((prev) => {
      if (prev.steps.length <= 1) return prev;
      return { ...prev, steps: prev.steps.filter((_, i) => i !== idx) };
    });
  }

  function addIng(stepIdx) {
    setBuilder((prev) => {
      const next = prev.steps.slice();
      next[stepIdx] = {
        ...next[stepIdx],
        ingredients: [...next[stepIdx].ingredients, { name: '', amount: '', unit: 'tsp' }],
      };
      return { ...prev, steps: next };
    });
  }

  function removeIng(stepIdx, ingIdx) {
    setBuilder((prev) => {
      const next = prev.steps.slice();
      const ings = next[stepIdx].ingredients;
      if (ings.length <= 1) return prev;
      next[stepIdx] = { ...next[stepIdx], ingredients: ings.filter((_, i) => i !== ingIdx) };
      return { ...prev, steps: next };
    });
  }

  function toggleItemPair(itemId) {
    setBuilder((prev) => {
      const has = prev.itemIds.includes(itemId);
      return {
        ...prev,
        itemIds: has ? prev.itemIds.filter((id) => id !== itemId) : [...prev.itemIds, itemId],
      };
    });
  }

  function pickCuisine(c) {
    patch({ cuisine: c.name, cuisineEmoji: c.emoji });
  }

  async function handleImport() {
    const url = (importUrl || '').trim();
    if (!url) return;
    setImporting(true);
    setImportError(null);
    try {
      const parsed = await api.importRecipeFromUrl(url);
      setBuilder((prev) => applyParsedRecipe(prev, parsed));
      setImportUrl('');
    } catch (e) {
      setImportError(e.message || 'Could not import recipe');
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    if (!validation.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        name: builder.name.trim(),
        cuisine: builder.cuisine.trim(),
        cuisineEmoji: builder.cuisineEmoji || '',
        color: builder.color,
        description: (builder.description || '').trim() || null,
        sourceUrl: (builder.sourceUrl || '').trim() || null,
        sauceType: builder.sauceType,
        parentSauceId: builder.parentSauceId,
        itemIds: builder.itemIds,
        steps: builder.steps.map((s, i) => ({
          stepOrder: i + 1,
          title: s.title.trim(),
          instructions: (s.instructions || '').trim() || null,
          inputFromStep: s.inputFromStep,
          estimatedTime: 5,
          ingredients: s.ingredients
            .filter((ing) => ing.name && ing.name.trim())
            .map((ing) => ({
              name: ing.name.trim(),
              amount: ing.unit === 'to taste' ? 0 : parseFloat(ing.amount) || 0,
              unit: ing.unit,
            })),
        })),
      };
      if (editingId) {
        await api.updateSauce(editingId, payload);
      } else {
        await api.createSauce(payload);
      }
      // Refresh the manager list so the new/updated sauce appears on return.
      await actions.loadAllSauces();
      navigation.goBack();
    } catch (e) {
      setSaveError(e.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  if (loadingExisting) {
    return (
      <View style={[styles.screen, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  if (!state.currentUser) {
    return (
      <View style={styles.screen}>
        <EmptyState
          title="Sign in to author sauces"
          body="Creating and editing recipes requires an account."
          action="Back"
          onAction={() => navigation.goBack()}
        />
      </View>
    );
  }

  const allItems = [
    { label: 'Carbs', list: items.carbs },
    { label: 'Proteins', list: items.proteins },
    { label: 'Salads', list: items.salads },
  ];

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10}>
            <ChevronLeft size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>{editingId ? 'Edit sauce' : 'New sauce'}</Text>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollBody}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Import from URL */}
        {!editingId ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Import from URL</Text>
            <View style={styles.importRow}>
              <Link2 size={16} color={COLORS.textMuted} style={{ marginRight: 6 }} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={importUrl}
                onChangeText={setImportUrl}
                placeholder="https://example.com/recipe"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[styles.smallBtn, (!importUrl || importing) && styles.btnDisabled]}
                onPress={handleImport}
                disabled={!importUrl || importing}
                activeOpacity={0.8}
              >
                {importing ? <ActivityIndicator color="#fff" /> : <Text style={styles.smallBtnLabel}>Import</Text>}
              </TouchableOpacity>
            </View>
            {importError ? <Text style={styles.error}>{importError}</Text> : null}
            <Text style={styles.help}>
              Paste a recipe URL — we'll prefill steps and ingredients. You can edit before saving.
            </Text>
          </View>
        ) : null}

        {/* Basics */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Basics</Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={builder.name}
            onChangeText={(v) => patch({ name: v })}
            placeholder="Garlic butter pan sauce"
            placeholderTextColor={COLORS.textMuted}
          />

          <Text style={styles.label}>Type</Text>
          <View style={styles.pillRow}>
            {SAUCE_TYPES.map((t) => {
              const active = builder.sauceType === t.value;
              return (
                <TouchableOpacity
                  key={t.value}
                  onPress={() => patch({ sauceType: t.value })}
                  style={[styles.pill, active && styles.pillActive]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.label}>Cuisine</Text>
          <View style={styles.pillRow}>
            {CUISINES.map((c) => {
              const active = builder.cuisine === c.name;
              return (
                <TouchableOpacity
                  key={c.name}
                  onPress={() => pickCuisine(c)}
                  style={[styles.pill, active && styles.pillActive]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>
                    {c.emoji} {c.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.label}>Color</Text>
          <View style={styles.swatchRow}>
            {COLOR_SWATCHES.map((sw) => {
              const active = builder.color === sw;
              return (
                <TouchableOpacity
                  key={sw}
                  onPress={() => patch({ color: sw })}
                  style={[
                    styles.swatch,
                    { backgroundColor: sw },
                    active && styles.swatchActive,
                  ]}
                />
              );
            })}
          </View>

          <Text style={styles.label}>Description (optional)</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={builder.description}
            onChangeText={(v) => patch({ description: v })}
            placeholder="Bright, lemony, ready in 5 minutes"
            placeholderTextColor={COLORS.textMuted}
            multiline
          />

          <Text style={styles.label}>Source URL (optional)</Text>
          <TextInput
            style={styles.input}
            value={builder.sourceUrl}
            onChangeText={(v) => patch({ sourceUrl: v })}
            placeholder="https://example.com/your-recipe"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Pair with items */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Pair with</Text>
          <Text style={styles.help}>
            Sauces show up under the dish (carb / protein / salad) you pair them with on the home screen.
          </Text>
          {allItems.map((group) => (
            <View key={group.label} style={{ marginTop: 10 }}>
              <Text style={styles.label}>{group.label}</Text>
              <View style={styles.pillRow}>
                {group.list.length === 0 ? (
                  <Text style={styles.help}>(none)</Text>
                ) : (
                  group.list.map((item) => {
                    const active = builder.itemIds.includes(item.id);
                    return (
                      <TouchableOpacity
                        key={item.id}
                        onPress={() => toggleItemPair(item.id)}
                        style={[styles.pill, active && styles.pillActive]}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>
                          {item.emoji} {item.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            </View>
          ))}
        </View>

        {/* Steps */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Steps</Text>
          {builder.steps.map((step, idx) => (
            <View key={idx} style={styles.stepBox}>
              <View style={styles.stepHeader}>
                <Text style={styles.stepNumber}>Step {idx + 1}</Text>
                {builder.steps.length > 1 ? (
                  <TouchableOpacity
                    onPress={() => removeStep(idx)}
                    hitSlop={8}
                    style={styles.removeStep}
                  >
                    <Trash2 size={14} color={COLORS.dangerText} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={styles.label}>Title</Text>
              <TextInput
                style={styles.input}
                value={step.title}
                onChangeText={(v) => patchStep(idx, { title: v })}
                placeholder="Whisk everything together"
                placeholderTextColor={COLORS.textMuted}
              />
              <Text style={styles.label}>Instructions (optional)</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={step.instructions}
                onChangeText={(v) => patchStep(idx, { instructions: v })}
                placeholder="In a small bowl, combine the ingredients and whisk until smooth."
                placeholderTextColor={COLORS.textMuted}
                multiline
              />

              <Text style={[styles.label, { marginTop: 12 }]}>Ingredients</Text>
              {step.ingredients.map((ing, ingIdx) => (
                <View key={ingIdx} style={styles.ingRow}>
                  <View style={{ flex: 2 }}>
                    <FoodAutocomplete
                      value={ing.name}
                      onChange={(v) => patchIng(idx, ingIdx, { name: v })}
                      placeholder="Ingredient"
                    />
                  </View>
                  <TextInput
                    style={[styles.input, styles.ingAmount]}
                    value={ing.amount}
                    onChangeText={(v) => patchIng(idx, ingIdx, { amount: v.replace(/[^0-9.]/g, '') })}
                    placeholder={ing.unit === 'to taste' ? '—' : 'amt'}
                    placeholderTextColor={COLORS.textMuted}
                    keyboardType="decimal-pad"
                    editable={ing.unit !== 'to taste'}
                  />
                  <View style={styles.unitPicker}>
                    <UnitPicker value={ing.unit} onChange={(v) => patchIng(idx, ingIdx, { unit: v })} />
                  </View>
                  {step.ingredients.length > 1 ? (
                    <TouchableOpacity
                      style={styles.removeIng}
                      onPress={() => removeIng(idx, ingIdx)}
                      hitSlop={6}
                    >
                      <Minus size={14} color={COLORS.dangerText} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
              <TouchableOpacity onPress={() => addIng(idx)} style={styles.addBtn} activeOpacity={0.7}>
                <Plus size={14} color={COLORS.primary} />
                <Text style={styles.addBtnLabel}>Add ingredient</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity onPress={addStep} style={[styles.addBtn, { alignSelf: 'center', marginTop: 12 }]} activeOpacity={0.7}>
            <Plus size={14} color={COLORS.primary} />
            <Text style={styles.addBtnLabel}>Add step</Text>
          </TouchableOpacity>
        </View>

        {/* Unassigned ingredients (from URL import) */}
        {builder.unassignedIngredients.length > 0 ? (
          <View style={[styles.card, { borderColor: COLORS.warningText, borderWidth: 1 }]}>
            <Text style={styles.sectionLabel}>Unassigned ingredients</Text>
            <Text style={styles.help}>
              These came from the import but couldn't be matched to a step. Drag-add isn't supported on
              mobile yet — pick the ingredients you want and re-add them under the right step, then remove from this list.
            </Text>
            {builder.unassignedIngredients.map((u, i) => (
              <View key={i} style={styles.unassignedRow}>
                <Text style={styles.unassignedText}>
                  {u.name}{u.amount ? ` · ${u.amount} ${u.unit}` : ''}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setBuilder((prev) => ({
                      ...prev,
                      unassignedIngredients: prev.unassignedIngredients.filter((_, j) => j !== i),
                    }));
                  }}
                  hitSlop={6}
                >
                  <X size={14} color={COLORS.dangerText} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}

        {/* Validation + Save */}
        <View style={styles.card}>
          {!validation.ok ? (
            <View style={styles.errorBlock}>
              <Text style={styles.errorTitle}>Fix before saving</Text>
              {validation.errors.map((e, i) => (
                <Text key={i} style={styles.errorBullet}>• {e}</Text>
              ))}
            </View>
          ) : null}
          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
          <TouchableOpacity
            style={[styles.saveBtn, (!validation.ok || saving) && styles.btnDisabled]}
            onPress={handleSave}
            disabled={!validation.ok || saving}
            activeOpacity={0.85}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Save size={16} color="#fff" />
                <Text style={styles.saveBtnLabel}>{editingId ? 'Save changes' : 'Create sauce'}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function UnitPicker({ value, onChange }) {
  // Inline horizontal scroll picker — keeps the form simple on mobile.
  const [open, setOpen] = useState(false);
  return (
    <View>
      <TouchableOpacity
        style={styles.unitBtn}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.7}
      >
        <Text style={styles.unitLabel} numberOfLines={1}>{value}</Text>
      </TouchableOpacity>
      {open ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.unitDropdown}
          keyboardShouldPersistTaps="handled"
        >
          {UNITS.map((u) => (
            <TouchableOpacity
              key={u}
              style={[styles.unitOption, u === value && styles.unitOptionActive]}
              onPress={() => { onChange(u); setOpen(false); }}
            >
              <Text style={[styles.unitOptionLabel, u === value && styles.unitOptionLabelActive]}>{u}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
  },
  scrollBody: {
    padding: 16,
    paddingBottom: 60,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    ...SHADOWS.sm,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.text,
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
    letterSpacing: 0.3,
    marginTop: 8,
    marginBottom: 4,
  },
  input: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: COLORS.text,
  },
  multiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
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
  pillLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  pillLabelActive: {
    color: '#fff',
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchActive: {
    borderColor: COLORS.text,
  },
  importRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  smallBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginLeft: 6,
  },
  smallBtnLabel: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 12,
  },
  btnDisabled: {
    opacity: 0.45,
  },
  help: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 6,
    lineHeight: 14,
  },
  stepBox: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primary,
    letterSpacing: 0.5,
  },
  removeStep: {
    padding: 4,
  },
  ingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 6,
  },
  ingAmount: {
    width: 60,
  },
  unitPicker: {
    minWidth: 70,
  },
  unitBtn: {
    backgroundColor: COLORS.background,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    minWidth: 70,
    alignItems: 'center',
  },
  unitLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.text,
  },
  unitDropdown: {
    paddingVertical: 6,
  },
  unitOption: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginRight: 4,
    backgroundColor: COLORS.card,
  },
  unitOptionActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  unitOptionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.text,
  },
  unitOptionLabelActive: {
    color: '#fff',
  },
  removeIng: {
    width: 28,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  addBtnLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
    marginLeft: 6,
  },
  unassignedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  unassignedText: {
    fontSize: 13,
    color: COLORS.text,
  },
  errorBlock: {
    backgroundColor: COLORS.danger,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  errorTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.dangerText,
    marginBottom: 4,
  },
  errorBullet: {
    fontSize: 12,
    color: COLORS.dangerText,
    marginVertical: 1,
  },
  error: {
    color: COLORS.dangerText,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 14,
    marginTop: 4,
  },
  saveBtnLabel: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    marginLeft: 6,
  },
});
