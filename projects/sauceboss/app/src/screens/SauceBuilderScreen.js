// SauceBuilderScreen — single-screen form for creating or editing a sauce.
// Uses #shared/validation.validateBuilder so the rules match the web app.
// Authoring scope (per the plan): authoring + URL import. Bulk admin (item
// management, ingredient merge) stays on web.

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
  FileUp,
  Save,
  X,
  CornerDownRight,
  ArrowRight,
} from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useAppActions, useAppState } from '../store/AppContext';
import { api } from '../api/client';
import { CUISINES, UNITS, COLOR_SWATCHES, SAUCE_TYPES } from '#shared/constants';
import { validateBuilder } from '#shared/validation';
import { applyParsedRecipe, builderFromSauce } from '#shared/builder';
import FoodAutocomplete from '../components/FoodAutocomplete';
import EmptyState from '../components/EmptyState';
import { COLORS, SHADOWS } from '../theme';

function emptyStep() {
  return {
    title: '',
    instructions: '',
    inputFromStep: null,
    estimatedTime: '',
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
  // Two-step flow: edit form → review screen → save. Tapping "Review" sends
  // you to a read-only summary; tapping "Confirm and save" from there fires
  // the actual create/update request.
  const [reviewing, setReviewing] = useState(false);

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
        // Always fetch fresh on edit. Using state.managerSauces as a cache
        // bites when the user just saved this sauce a moment ago — the
        // manager refresh on focus may not have raced ahead of the
        // re-open, so the row could be stale. /sauces is one round-trip.
        let sauce = null;
        try {
          const all = await api.allSauces();
          sauce = all.find((s) => s.id === editingId);
        } catch {
          // Fall back to the cached row if the network request fails.
          sauce = state.managerSauces.find((s) => s.id === editingId) || null;
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
      const removedOrder = idx + 1;
      const steps = prev.steps
        .filter((_, i) => i !== idx)
        // Any step that was combining the removed one's output loses the link.
        // Steps that pointed at a later index get their pointer shifted down.
        .map((s) => {
          if (s.inputFromStep == null) return s;
          if (s.inputFromStep === removedOrder) return { ...s, inputFromStep: null };
          if (s.inputFromStep > removedOrder) return { ...s, inputFromStep: s.inputFromStep - 1 };
          return s;
        });
      return { ...prev, steps };
    });
  }

  function setInputFromStep(stepIdx, value) {
    setBuilder((prev) => {
      const next = prev.steps.slice();
      // Refuse self-references and forward references.
      if (value != null && (value <= 0 || value > stepIdx)) {
        return prev;
      }
      next[stepIdx] = { ...next[stepIdx], inputFromStep: value };
      return { ...prev, steps: next };
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

  // Move an ingredient out of the unassigned tray and into the chosen step.
  // Strips internal helper fields so the row matches an emptyStep() ingredient.
  function moveUnassignedToStep(uIdx, stepIdx) {
    setBuilder((prev) => {
      if (uIdx < 0 || uIdx >= prev.unassignedIngredients.length) return prev;
      if (stepIdx < 0 || stepIdx >= prev.steps.length) return prev;
      const ing = prev.unassignedIngredients[uIdx];
      const steps = prev.steps.slice();
      // If the target step still has a single empty placeholder row, replace
      // it instead of stacking on top so we don't end up with a blank line.
      const targetIngs = steps[stepIdx].ingredients;
      const onlyHasEmptyPlaceholder =
        targetIngs.length === 1 &&
        !targetIngs[0].name &&
        !targetIngs[0].amount;
      const newIng = {
        name: ing.name || '',
        amount: ing.amount != null ? String(ing.amount) : '',
        unit: ing.unit || 'tsp',
        originalText: ing.originalText || '',
        canonicalMl: ing.canonicalMl != null ? ing.canonicalMl : null,
        canonicalG: ing.canonicalG != null ? ing.canonicalG : null,
      };
      steps[stepIdx] = {
        ...steps[stepIdx],
        ingredients: onlyHasEmptyPlaceholder ? [newIng] : [...targetIngs, newIng],
      };
      const unassigned = prev.unassignedIngredients.filter((_, i) => i !== uIdx);
      return { ...prev, steps, unassignedIngredients: unassigned };
    });
  }

  function deleteUnassigned(uIdx) {
    setBuilder((prev) => ({
      ...prev,
      unassignedIngredients: prev.unassignedIngredients.filter((_, i) => i !== uIdx),
    }));
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

  // File-import counterpart to handleImport: parse a `.sauce.json` (the same
  // shape produced by the export endpoints) into a fresh builder draft, then
  // route through the existing review + save flow. Mirrors the web's
  // handleImportSauceFile (settings.js).
  async function handleImportFromFile() {
    setImporting(true);
    setImportError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'public.json', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled) return;
      const file = res.assets?.[0];
      if (!file?.uri) return;

      const text = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        Alert.alert('Import failed', `File is not valid JSON: ${e.message}`);
        return;
      }

      if (raw && Array.isArray(raw.sauces)) {
        Alert.alert(
          'Bulk imports not supported',
          'Split the file into per-sauce JSONs and try again.',
        );
        return;
      }
      if (raw && raw.version != null && raw.version !== 1) {
        Alert.alert('Unsupported version', `Export version: ${raw.version}`);
        return;
      }

      const inner = (raw && typeof raw.sauce === 'object' && raw.sauce !== null) ? raw.sauce : raw;
      if (!inner || typeof inner !== 'object' || !inner.name || !Array.isArray(inner.steps)) {
        Alert.alert(
          'Could not locate sauce payload',
          'Expected an object with `name` and `steps`.',
        );
        return;
      }

      // Drop a parentSauceId that doesn't resolve in this catalog so the
      // builder's parent dropdown doesn't show a phantom selection.
      let parent = inner.parentSauceId || null;
      if (parent) {
        const known = (state.managerSauces || []).some((s) => s.id === parent);
        if (!known) {
          Alert.alert('Parent sauce dropped', `"${parent}" not found in this catalog.`);
          parent = null;
        }
      }

      setBuilder(builderFromSauce({ ...inner, parentSauceId: parent }));
    } catch (e) {
      setImportError(e.message || 'Could not read file.');
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    if (!validation.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Backend models: `description` and `cuisineEmoji` are non-Optional
      // strings (default ""); sending null fails with 422. `sourceUrl` is
      // Optional[str] so null is fine. `parentSauceId` is Optional[str] —
      // empty string would also pass but null is cleaner.
      const payload = {
        name: builder.name.trim(),
        cuisine: builder.cuisine.trim(),
        cuisineEmoji: builder.cuisineEmoji || '',
        color: builder.color,
        description: (builder.description || '').trim(),
        sourceUrl: (builder.sourceUrl || '').trim() || null,
        sauceType: builder.sauceType,
        parentSauceId: builder.parentSauceId || null,
        itemIds: builder.itemIds,
        steps: builder.steps.map((s, i) => {
          // Empty input -> null so the recipe view falls back to the
          // legacy 5-min default. Cap at 600 to keep the int small.
          const rawTime = (s.estimatedTime ?? '').toString().trim();
          const parsedTime = rawTime === '' ? null : Math.max(0, Math.min(600, parseInt(rawTime, 10) || 0));
          return {
            stepOrder: i + 1,
            title: s.title.trim(),
            instructions: (s.instructions || '').trim() || null,
            inputFromStep: s.inputFromStep,
            estimatedTime: parsedTime,
            ingredients: s.ingredients
              .filter((ing) => ing.name && ing.name.trim())
              .map((ing) => ({
                name: ing.name.trim(),
                amount: ing.unit === 'to taste' ? 0 : parseFloat(ing.amount) || 0,
                unit: ing.unit,
              })),
          };
        }),
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

  // The backend enforces sauce↔category pairing (sauce/carb, marinade/protein,
  // dressing/salad). Mirror that constraint here so the picker only shows the
  // group that matches the current sauceType — same logic as web's flowMetaFor.
  const typeMeta = SAUCE_TYPES.find((t) => t.value === builder.sauceType) || SAUCE_TYPES[0];
  const allowedItems = typeMeta.category === 'protein' ? items.proteins
    : typeMeta.category === 'salad' ? items.salads
    : items.carbs;
  const pairLabel = typeMeta.pairLabel;

  if (reviewing) {
    return (
      <ReviewScreen
        builder={builder}
        items={items}
        editingId={editingId}
        saving={saving}
        saveError={saveError}
        insets={insets}
        onBack={() => setReviewing(false)}
        onConfirm={handleSave}
      />
    );
  }

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
        contentContainerStyle={[
          styles.scrollBody,
          { paddingBottom: Math.max(60, insets.bottom + 24) },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Import from URL or .sauce.json file */}
        {!editingId ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Import recipe</Text>
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
            <View style={styles.importFileRow}>
              <Text style={styles.help}>Or pick a .sauce.json file you exported earlier.</Text>
              <TouchableOpacity
                style={[styles.smallBtnSecondary, importing && styles.btnDisabled]}
                onPress={handleImportFromFile}
                disabled={importing}
                activeOpacity={0.8}
              >
                <FileUp size={14} color={COLORS.primary} style={{ marginRight: 4 }} />
                <Text style={styles.smallBtnSecondaryLabel}>From file</Text>
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
                  onPress={() => patch({ sauceType: t.value, itemIds: [] })}
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

        {/* Pair with items — filtered to the category that matches sauceType */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Pair with {pairLabel.toLowerCase()}</Text>
          <Text style={styles.help}>
            {typeMeta.label}s pair with {pairLabel.toLowerCase()}. Change the type above to pair with a different group.
          </Text>
          <View style={[styles.pillRow, { marginTop: 8 }]}>
            {allowedItems.length === 0 ? (
              <Text style={styles.help}>No {pairLabel.toLowerCase()} in the catalog yet.</Text>
            ) : (
              allowedItems.map((item) => {
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

              {/* Combine output from a previous step. Only meaningful from
                  Step 2 onward; the first step has no upstream. */}
              {idx > 0 ? (
                <>
                  <Text style={styles.label}>Combine output from</Text>
                  <View style={styles.pillRow}>
                    <TouchableOpacity
                      onPress={() => setInputFromStep(idx, null)}
                      style={[styles.pill, step.inputFromStep == null && styles.pillActive]}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.pillLabel, step.inputFromStep == null && styles.pillLabelActive]}>
                        None
                      </Text>
                    </TouchableOpacity>
                    {builder.steps.slice(0, idx).map((upstream, uidx) => {
                      const order = uidx + 1;
                      const active = step.inputFromStep === order;
                      const tail = upstream.title ? ` — ${upstream.title.slice(0, 18)}` : '';
                      return (
                        <TouchableOpacity
                          key={uidx}
                          onPress={() => setInputFromStep(idx, order)}
                          style={[styles.pill, active && styles.pillActive]}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.pillLabel, active && styles.pillLabelActive]}>
                            Step {order}{tail}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  {step.inputFromStep ? (
                    <View style={styles.refBadge}>
                      <CornerDownRight size={12} color={COLORS.primaryDark} />
                      <Text style={styles.refBadgeText}>
                        Combines all of Step {step.inputFromStep} into this bowl
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : null}

              <View style={styles.titleRow}>
                <View style={styles.titleCol}>
                  <Text style={styles.label}>Title</Text>
                  <TextInput
                    style={styles.input}
                    value={step.title}
                    onChangeText={(v) => patchStep(idx, { title: v })}
                    placeholder="Whisk everything together"
                    placeholderTextColor={COLORS.textMuted}
                  />
                </View>
                <View style={styles.timeCol}>
                  <Text style={styles.label}>Time</Text>
                  <View style={styles.timeWrap}>
                    <TextInput
                      style={styles.timeInput}
                      value={step.estimatedTime ?? ''}
                      onChangeText={(v) => patchStep(idx, { estimatedTime: v.replace(/[^0-9]/g, '') })}
                      placeholder="5"
                      placeholderTextColor={COLORS.textMuted}
                      keyboardType="number-pad"
                      maxLength={3}
                    />
                    <Text style={styles.timeSuffix}>min</Text>
                  </View>
                </View>
              </View>
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
            <View style={styles.sectionRow}>
              <Text style={styles.sectionLabel}>
                ⚠ Unassigned ingredients ({builder.unassignedIngredients.length})
              </Text>
            </View>
            <Text style={styles.help}>
              These came from the import but couldn't be matched to a step. Tap a step to move
              an ingredient into it, or × to delete. The recipe can't save while this list is non-empty.
            </Text>
            {builder.unassignedIngredients.map((u, i) => (
              <View key={i} style={styles.unassignedCard}>
                <View style={styles.unassignedHeader}>
                  <Text style={styles.unassignedName} numberOfLines={1}>
                    {u.name}
                  </Text>
                  {u.amount ? (
                    <Text style={styles.unassignedQty}>
                      {u.amount}{u.unit ? ` ${u.unit}` : ''}
                    </Text>
                  ) : null}
                  <TouchableOpacity
                    onPress={() => deleteUnassigned(i)}
                    hitSlop={6}
                    style={styles.unassignedDelete}
                  >
                    <X size={14} color={COLORS.dangerText} />
                  </TouchableOpacity>
                </View>
                <View style={styles.unassignedTargets}>
                  <ArrowRight size={12} color={COLORS.textSecondary} />
                  {builder.steps.map((s, si) => {
                    const tail = s.title ? ` — ${s.title.slice(0, 14)}` : '';
                    return (
                      <TouchableOpacity
                        key={si}
                        onPress={() => moveUnassignedToStep(i, si)}
                        style={styles.targetPill}
                        activeOpacity={0.8}
                      >
                        <Text style={styles.targetPillLabel}>Step {si + 1}{tail}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* Validation + Continue to review */}
        <View style={styles.card}>
          {!validation.ok ? (
            <View style={styles.errorBlock}>
              <Text style={styles.errorTitle}>Fix before continuing</Text>
              {validation.errors.map((e, i) => (
                <Text key={i} style={styles.errorBullet}>• {e}</Text>
              ))}
            </View>
          ) : null}
          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
          <TouchableOpacity
            style={[styles.saveBtn, !validation.ok && styles.btnDisabled]}
            onPress={() => { setSaveError(null); setReviewing(true); }}
            disabled={!validation.ok}
            activeOpacity={0.85}
          >
            <Text style={styles.saveBtnLabel}>Continue to review</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Read-only summary shown after the user finishes editing. Two paths out:
// "Back to edit" returns to the form; "Confirm and save" fires the API.
function ReviewScreen({ builder, items, editingId, saving, saveError, insets, onBack, onConfirm }) {
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

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} hitSlop={10} disabled={saving}>
            <ChevronLeft size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Review</Text>
          <View style={{ width: 22 }} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollBody,
          { paddingBottom: Math.max(60, insets.bottom + 24) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Summary card */}
        <View style={styles.card}>
          <View style={styles.reviewHeader}>
            <View style={[styles.reviewSwatch, { backgroundColor: builder.color }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.reviewName} numberOfLines={2}>{builder.name}</Text>
              <Text style={styles.reviewMeta}>
                {typeMeta.label}{builder.cuisine ? ` · ${builder.cuisineEmoji ? `${builder.cuisineEmoji} ` : ''}${builder.cuisine}` : ''}
              </Text>
            </View>
          </View>
          {builder.description ? (
            <Text style={styles.reviewDescription}>{builder.description}</Text>
          ) : null}
          <View style={styles.reviewMetaRow}>
            <Text style={styles.reviewMetaLabel}>~{totalTime} min · {builder.steps.length} step{builder.steps.length === 1 ? '' : 's'}</Text>
          </View>
        </View>

        {/* Pairing */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Paired with</Text>
          {pairedItems.length === 0 ? (
            <Text style={styles.help}>Nothing paired.</Text>
          ) : (
            <View style={styles.pillRow}>
              {pairedItems.map((item) => (
                <View key={item.id} style={[styles.pill, styles.pillActive]}>
                  <Text style={[styles.pillLabel, styles.pillLabelActive]}>
                    {item.emoji} {item.name}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Steps */}
        {builder.steps.map((step, idx) => {
          const stepTime = (() => {
            const t = parseInt((step.estimatedTime ?? '').toString(), 10);
            return Number.isFinite(t) && t > 0 ? t : 5;
          })();
          const visibleIngs = step.ingredients.filter((i) => i.name && i.name.trim());
          return (
            <View key={idx} style={styles.card}>
              <View style={styles.reviewStepHeader}>
                <Text style={styles.reviewStepNumber}>STEP {idx + 1}</Text>
                <Text style={styles.reviewStepTime}>~{stepTime}m</Text>
              </View>
              {step.title ? <Text style={styles.reviewStepTitle}>{step.title}</Text> : null}
              {step.inputFromStep ? (
                <View style={styles.refBadge}>
                  <CornerDownRight size={12} color={COLORS.primaryDark} />
                  <Text style={styles.refBadgeText}>
                    Combines all of Step {step.inputFromStep} into this bowl
                  </Text>
                </View>
              ) : null}
              {step.instructions ? (
                <Text style={styles.reviewStepInstructions}>{step.instructions}</Text>
              ) : null}
              {visibleIngs.length > 0 ? (
                <View style={styles.reviewIngList}>
                  {visibleIngs.map((ing, ii) => (
                    <View key={ii} style={styles.reviewIngRow}>
                      <Text style={styles.reviewIngName} numberOfLines={1}>{ing.name}</Text>
                      <Text style={styles.reviewIngQty}>
                        {ing.unit === 'to taste' ? 'to taste' : `${ing.amount || '0'} ${ing.unit}`}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}

        {/* Confirm */}
        <View style={styles.card}>
          {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.btnDisabled]}
            onPress={onConfirm}
            disabled={saving}
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
          <TouchableOpacity
            style={styles.backToEditBtn}
            onPress={onBack}
            disabled={saving}
            activeOpacity={0.7}
          >
            <Text style={styles.backToEditLabel}>Back to edit</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
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
  titleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  titleCol: {
    flex: 1,
  },
  timeCol: {
    width: 84,
  },
  timeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingRight: 10,
  },
  timeInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: COLORS.text,
    textAlign: 'right',
  },
  timeSuffix: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
    marginLeft: 4,
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
  smallBtnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 8,
  },
  smallBtnSecondaryLabel: {
    color: COLORS.primary,
    fontWeight: '700',
    fontSize: 12,
  },
  importFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
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
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  refBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.highlightTint,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginTop: 4,
    marginBottom: 4,
  },
  refBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.primaryDark,
    marginLeft: 4,
    flex: 1,
  },
  unassignedCard: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  unassignedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  unassignedName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  unassignedQty: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginRight: 8,
  },
  unassignedDelete: {
    padding: 4,
  },
  unassignedTargets: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  targetPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.card,
  },
  targetPillLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
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
  backToEditBtn: {
    marginTop: 10,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  backToEditLabel: {
    color: COLORS.textSecondary,
    fontWeight: '700',
    fontSize: 13,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  reviewSwatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 12,
  },
  reviewName: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.text,
  },
  reviewMeta: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  reviewDescription: {
    fontSize: 13,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginTop: 4,
  },
  reviewMetaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewMetaLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 0.4,
  },
  reviewStepHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  reviewStepNumber: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.primary,
    letterSpacing: 0.6,
  },
  reviewStepTime: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  reviewStepTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  reviewStepInstructions: {
    fontSize: 13,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginVertical: 4,
  },
  reviewIngList: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: COLORS.surfaceSubtle,
  },
  reviewIngRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  reviewIngName: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    marginRight: 8,
  },
  reviewIngQty: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
});
