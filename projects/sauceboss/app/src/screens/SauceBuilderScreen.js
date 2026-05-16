// SauceBuilderScreen — single-screen form for creating or editing a sauce.
// Uses #shared/validation.validateBuilder so the rules match the web app.
// Authoring scope (per the plan): authoring + URL import. Bulk admin (item
// management, ingredient merge) stays on web.

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useAppActions, useAppState } from '../store/AppContext';
import { api } from '../api/client';
import { COLOR_SWATCHES, SAUCE_TYPES } from '#shared/constants';
import { validateBuilder } from '#shared/validation';
import { applyParsedRecipe, builderFromSauce } from '#shared/builder';
import IngredientEditorSheet from '../components/IngredientEditorSheet';
import StepInputSheet from '../components/StepInputSheet';
import EmptyState from '../components/EmptyState';
import BuilderProgressDots, { WIZARD_STEPS } from './builder/BuilderProgressDots';
import SourceStep from './builder/SourceStep';
import InfoStep from './builder/InfoStep';
import PairingStep from './builder/PairingStep';
import InstructionsStep from './builder/InstructionsStep';
import ReviewStep from './builder/ReviewStep';
import styles from './builder/builderStyles';
import { COLORS, SHADOWS } from '../theme';

const STEP_ORDER = ['source', 'info', 'instructions', 'pairing', 'review'];
const STEP_INDEX = Object.fromEntries(STEP_ORDER.map((s, i) => [s, i]));
const STEP_LABELS = {
  source: 'Recipe Source',
  info: 'Recipe Info',
  instructions: 'Recipe Steps',
  pairing: 'Dish Pairing',
  review: 'Review',
};

function emptyStep() {
  return {
    title: '',
    instructions: '',
    inputFromSteps: [],
    estimatedTime: '',
    // Empty ingredients list — the bottom-sheet editor is the only entry
    // point. Matches the web's behavior post-ab37b01.
    ingredients: [],
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
  // Bottom-sheet ingredient editor state. `ii === -1` means a new row is being
  // added (commits on Save). Otherwise an existing row is being edited.
  // Mirrors web's state.builder._ingEditor.
  const [ingEditor, setIngEditor] = useState(null);

  // Five-step wizard: source → info → instructions → pairing → review.
  // Editing an existing sauce skips source (no need to re-import) and lands
  // on info. `returnToReview` is set when the user taps an Edit pill from
  // the Review step — Continue then jumps back to Review instead of
  // advancing linearly. Mirrors web's b.returnToReview flow.
  // Editing starts on the review screen (matches web). Edit pills jump
  // to the relevant step; Continue / Back returns to review.
  const [currentStep, setCurrentStep] = useState(editingId ? 'review' : 'source');
  const [returnToReview, setReturnToReview] = useState(false);
  const currentIndex = STEP_INDEX[currentStep];
  // Standalone recipes (sauceType: 'full_recipe') skip the pairing step
  // since they don't pair with a dish category. Web reads
  // SAUCE_TYPES[i].category === null for this signal.
  const isStandalone = useMemo(() => {
    const meta = SAUCE_TYPES.find((t) => t.value === builder.sauceType);
    return meta?.category === null;
  }, [builder.sauceType]);

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

  // Unit lookup tables derived from refUnits. `units` is the flat list of
  // abbreviations the sheet renders as chips; `qualitativeUnits` is the set
  // of unquantifiable units (e.g. "to taste") that disable the amount input
  // and exclude the ingredient from the pie chart.
  const units = useMemo(
    () => (state.refUnits || []).map((u) => u.abbreviation || u.id),
    [state.refUnits],
  );
  const qualitativeUnits = useMemo(
    () =>
      new Set(
        (state.refUnits || [])
          .filter((u) => u.quantifiable === false)
          .map((u) => u.abbreviation || u.id),
      ),
    [state.refUnits],
  );

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

  function openIngEdit(si, ii) {
    const source = builder.steps[si]?.ingredients?.[ii];
    if (!source) return;
    setIngEditor({
      si,
      ii,
      draft: {
        name: source.name || '',
        amount: source.amount === '' || source.amount == null ? '' : String(source.amount),
        unit: source.unit || 'tsp',
        modifier: source.modifier || null,
        originalText: source.originalText || '',
        canonicalMl: source.canonicalMl ?? null,
        canonicalG: source.canonicalG ?? null,
      },
    });
  }

  function openIngAdd(si) {
    setIngEditor({
      si,
      ii: -1,
      draft: {
        name: '',
        amount: '',
        unit: 'tsp',
        modifier: null,
        originalText: '',
        canonicalMl: null,
        canonicalG: null,
      },
    });
  }

  function updateIngDraft(field, value) {
    setIngEditor((prev) => (prev ? { ...prev, draft: { ...prev.draft, [field]: value } } : prev));
  }

  function saveIngEditor() {
    if (!ingEditor) return;
    const { si, ii, draft } = ingEditor;
    const isQualitative = qualitativeUnits.has(draft.unit);
    if (!draft.name.trim() || (!isQualitative && !(parseFloat(draft.amount) > 0))) return;
    const row = {
      name: draft.name.trim(),
      amount: isQualitative ? '' : draft.amount,
      unit: draft.unit,
      modifier: (draft.modifier || '').trim() || null,
      originalText: draft.originalText || '',
      canonicalMl: draft.canonicalMl,
      canonicalG: draft.canonicalG,
    };
    setBuilder((prev) => {
      const steps = prev.steps.slice();
      const ings = (steps[si]?.ingredients || []).slice();
      if (ii < 0) ings.push(row);
      else ings[ii] = row;
      steps[si] = { ...steps[si], ingredients: ings };
      return { ...prev, steps };
    });
    setIngEditor(null);
  }

  function removeIngredient(si, ii) {
    setBuilder((prev) => {
      const steps = prev.steps.slice();
      const ings = (steps[si]?.ingredients || []).filter((_, i) => i !== ii);
      steps[si] = { ...steps[si], ingredients: ings };
      return { ...prev, steps };
    });
  }

  // `at` is the insertion index (0..steps.length). Default = append. When
  // inserting in the middle, any inputFromSteps refs that pointed at a
  // shifted step get bumped so combine arrows still resolve to the same
  // source step.
  function addStep(at) {
    setBuilder((prev) => {
      const idx = typeof at === 'number' ? Math.max(0, Math.min(prev.steps.length, at)) : prev.steps.length;
      const newStepOrder = idx + 1;
      const shifted = prev.steps.map((s) => {
        const refs = s.inputFromSteps || [];
        if (refs.length === 0) return s;
        return { ...s, inputFromSteps: refs.map((r) => (r >= newStepOrder ? r + 1 : r)) };
      });
      const next = shifted.slice(0, idx).concat(emptyStep(), shifted.slice(idx));
      return { ...prev, steps: next };
    });
  }

  function removeStep(idx) {
    setBuilder((prev) => {
      if (prev.steps.length <= 1) return prev;
      const removedOrder = idx + 1;
      const steps = prev.steps
        .filter((_, i) => i !== idx)
        // Any step that was combining the removed one's output loses that ref;
        // refs pointing at a later step get their order shifted down.
        .map((s) => {
          const refs = s.inputFromSteps || [];
          if (refs.length === 0) return s;
          const inputFromSteps = refs
            .filter((r) => r !== removedOrder)
            .map((r) => (r > removedOrder ? r - 1 : r));
          return { ...s, inputFromSteps };
        });
      return { ...prev, steps };
    });
  }

  // Step-input editor (bottom-sheet) state. The draft array is cloned on
  // open and only commits when the user taps Save. Mirrors web's
  // state.builder._stepInputEditor.
  // {  si: number, draft: number[] }  | null
  const [stepInputEditor, setStepInputEditor] = useState(null);

  function openStepInputEditor(si) {
    setStepInputEditor({
      si,
      draft: ((builder.steps[si] || {}).inputFromSteps || []).slice(),
    });
  }

  function toggleStepInputDraft(refOrder) {
    setStepInputEditor((prev) => {
      if (!prev) return prev;
      const has = prev.draft.includes(refOrder);
      const next = has ? prev.draft.filter((r) => r !== refOrder) : [...prev.draft, refOrder];
      return { ...prev, draft: next };
    });
  }

  function saveStepInputEditor() {
    if (!stepInputEditor) return;
    const { si, draft } = stepInputEditor;
    setBuilder((prev) => {
      const steps = prev.steps.slice();
      steps[si] = {
        ...steps[si],
        inputFromSteps: draft.slice().sort((a, b) => a - b),
      };
      return { ...prev, steps };
    });
    setStepInputEditor(null);
  }

  function clearStepInput(si) {
    setBuilder((prev) => {
      const steps = prev.steps.slice();
      steps[si] = { ...steps[si], inputFromSteps: [] };
      return { ...prev, steps };
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

  // Type selector lives on the Pairing step (mirrors web). Changing type
  // wipes the picked itemIds since the legal pool changes — same behavior
  // as web's builderSetSauceType.
  function setSauceType(value) {
    setBuilder((prev) =>
      prev.sauceType === value ? prev : { ...prev, sauceType: value, itemIds: [] },
    );
  }

  // Replace the entire itemIds array atomically. Used by the dish-tree
  // parent toggle when selecting/deselecting a parent + all its variants
  // in one shot.
  function setItemIds(next) {
    setBuilder((prev) => ({ ...prev, itemIds: Array.isArray(next) ? next : next(prev.itemIds) }));
  }

  // Move an ingredient out of the unassigned tray and into the chosen step.
  // Strips internal helper fields so the row matches an emptyStep() ingredient.
  function moveUnassignedToStep(uIdx, stepIdx) {
    setBuilder((prev) => {
      if (uIdx < 0 || uIdx >= prev.unassignedIngredients.length) return prev;
      if (stepIdx < 0 || stepIdx >= prev.steps.length) return prev;
      const ing = prev.unassignedIngredients[uIdx];
      const steps = prev.steps.slice();
      const newIng = {
        name: ing.name || '',
        amount: ing.amount != null ? String(ing.amount) : '',
        unit: ing.unit || 'tsp',
        modifier: (ing.modifier || '').trim() || null,
        originalText: ing.originalText || '',
        canonicalMl: ing.canonicalMl != null ? ing.canonicalMl : null,
        canonicalG: ing.canonicalG != null ? ing.canonicalG : null,
      };
      steps[stepIdx] = {
        ...steps[stepIdx],
        ingredients: [...(steps[stepIdx].ingredients || []), newIng],
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
      // Advance to the Info step on success so the user starts editing
      // metadata instead of staring at the Source cards.
      if (currentStep === 'source') setCurrentStep('info');
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
      if (currentStep === 'source') setCurrentStep('info');
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
        // Recipe-view scaling is anchored to defaultServings. Imports inherit
        // `yieldServings` via shared/builder.js#applyParsedRecipe (line 60);
        // manual + edit flows default to 2 if nothing is set.
        defaultServings: Number(builder.servings) || 2,
        steps: builder.steps.map((s, i) => {
          // Empty input -> null so the recipe view falls back to the
          // legacy 5-min default. Cap at 600 to keep the int small.
          const rawTime = (s.estimatedTime ?? '').toString().trim();
          const parsedTime = rawTime === '' ? null : Math.max(0, Math.min(600, parseInt(rawTime, 10) || 0));
          const refs = s.inputFromSteps || [];
          return {
            stepOrder: i + 1,
            title: s.title.trim(),
            instructions: (s.instructions || '').trim() || null,
            // Write both: `inputFromStep` (singular) keeps older clients
            // working; `inputFromSteps[]` is the canonical multi-ref shape.
            inputFromStep: refs[0] ?? null,
            inputFromSteps: refs,
            estimatedTime: parsedTime,
            ingredients: s.ingredients
              .filter((ing) => ing.name && ing.name.trim())
              .map((ing) => ({
                name: ing.name.trim(),
                amount: qualitativeUnits.has(ing.unit) ? 0 : parseFloat(ing.amount) || 0,
                unit: ing.unit,
                modifier: (ing.modifier || '').trim() || null,
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
      // For new sauces the backend's create_sauce auto-adds to the author's
      // saucebook (public_routes.py:122); refresh that too so the row shows
      // up immediately when the user returns to the Saucebook tab without
      // waiting for a manual pull-to-refresh.
      const refreshes = [actions.loadAllSauces()];
      if (!editingId && state.currentUser) {
        refreshes.push(actions.loadSaucebook());
      }
      await Promise.all(refreshes);
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
  // dressing/salad). The pairing step picks the right group internally; we
  // only need `isStandalone` here to drive step skipping + validation.

  // Per-step validation. Each step gates its Continue button based on the
  // subset of validation.errors that apply to its inputs.
  function isStepValid(step) {
    const e = validation.errors || [];
    if (step === 'info') {
      return !e.some((m) =>
        m === 'Sauce needs a name' ||
        m === 'Pick a cuisine' ||
        m === 'Pick a color' ||
        m === 'Choose Sauce, Marinade, or Dressing'
      );
    }
    if (step === 'instructions') {
      return !e.some((m) =>
        m === 'At least one step is required' ||
        m.startsWith('Step ') ||
        m.includes('needs an amount') ||
        m.startsWith('Drain ')
      );
    }
    if (step === 'pairing') {
      return isStandalone || !e.some((m) => m === 'Pair with at least one item');
    }
    return true;
  }

  // Step navigation. `goNext` jumps to Review when returnToReview is set
  // (Edit-from-Review shortcut); otherwise advances linearly, skipping
  // Pairing for full-recipe types. `goBack` mirrors that order in reverse
  // and pops the wizard when we're at the first visible step.
  function nextStep(from) {
    const i = STEP_INDEX[from];
    for (let j = i + 1; j < STEP_ORDER.length; j++) {
      const s = STEP_ORDER[j];
      if (s === 'pairing' && isStandalone) continue;
      return s;
    }
    return from;
  }
  function prevStep(from) {
    const i = STEP_INDEX[from];
    for (let j = i - 1; j >= 0; j--) {
      const s = STEP_ORDER[j];
      if (s === 'source' && editingId) continue;
      if (s === 'pairing' && isStandalone) continue;
      return s;
    }
    return null;
  }
  function goNext() {
    if (returnToReview) {
      setReturnToReview(false);
      setCurrentStep('review');
      return;
    }
    const next = nextStep(currentStep);
    if (next !== currentStep) setCurrentStep(next);
  }
  function goBack() {
    // If we're here via "Edit from review", return to review (mirrors the
    // forward returnToReview behavior of goNext).
    if (returnToReview) {
      setReturnToReview(false);
      setCurrentStep('review');
      return;
    }
    // Editing starts on review; tapping back there should close the
    // editor, not walk back into pairing/instructions.
    if (editingId && currentStep === 'review') {
      navigation.goBack();
      return;
    }
    const prev = prevStep(currentStep);
    if (prev) setCurrentStep(prev);
    else navigation.goBack();
  }
  function jumpToStep(step) {
    setReturnToReview(true);
    setCurrentStep(step);
  }

  // Exit the wizard entirely and land the user on the Saucebook tab. Used
  // by the header X and the Review screen's Discard button — both want
  // "close the builder, no save".
  function exitToSaucebook() {
    navigation.navigate('Home', { screen: 'SaucebookTab' });
  }
  // From the Source step, picking Manual Entry advances to Info immediately.
  const handleManualStart = () => goNext();

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          {/* Close button — exits the builder entirely and returns to the
              Saucebook tab. In-wizard step-back is via the "← Back to <step>"
              link below the Continue button on each step. */}
          <TouchableOpacity onPress={exitToSaucebook} hitSlop={10} style={styles.closeBtn}>
            <X size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Recipe Builder</Text>
          <View style={{ width: 32 }} />
        </View>
      </View>

      <BuilderProgressDots activeIndex={currentIndex} skipFirst={!!editingId} />

      <ScrollView
        contentContainerStyle={[
          styles.scrollBody,
          { paddingBottom: Math.max(60, insets.bottom + 24) },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Source step — URL / File / Manual import cards */}
        {currentStep === 'source' ? (
          <SourceStep
            importUrl={importUrl}
            setImportUrl={setImportUrl}
            importing={importing}
            importError={importError}
            handleImport={handleImport}
            handleImportFromFile={handleImportFromFile}
            handleManualStart={handleManualStart}
          />
        ) : null}

        {/* Info step — Name / Type / Cuisine / Color / Description / Source URL */}
        {currentStep === 'info' ? (
          <InfoStep
            builder={builder}
            refCuisines={state.refCuisines}
            patch={patch}
            pickCuisine={pickCuisine}
          />
        ) : null}

        {/* Pairing step — dish chips or standalone hint */}
        {currentStep === 'pairing' ? (
          <PairingStep
            builder={builder}
            items={items}
            setSauceType={setSauceType}
            setItemIds={setItemIds}
          />
        ) : null}

        {/* Instructions step — steps section + unassigned ingredients tray */}
        {currentStep === 'instructions' ? (
          <InstructionsStep
            builder={builder}
            qualitativeUnits={qualitativeUnits}
            ingredientCategories={state.ingredientCategories}
            patchStep={patchStep}
            addStep={addStep}
            removeStep={removeStep}
            openIngAdd={openIngAdd}
            openIngEdit={openIngEdit}
            removeIngredient={removeIngredient}
            openStepInputEditor={openStepInputEditor}
            clearStepInput={clearStepInput}
            moveUnassignedToStep={moveUnassignedToStep}
            deleteUnassigned={deleteUnassigned}
          />
        ) : null}

        {/* Review step — read-only summary with edit shortcuts.
            Each section has an Edit pill that sets returnToReview=true and
            jumps back to the relevant step. */}
        {currentStep === 'review' ? (
          <ReviewStep
            builder={builder}
            items={items}
            editingId={editingId}
            saving={saving}
            saveError={saveError}
            qualitativeUnits={qualitativeUnits}
            onEditInfo={() => jumpToStep('info')}
            onEditInstructions={() => jumpToStep('instructions')}
            onEditPairing={() => (isStandalone ? null : jumpToStep('pairing'))}
            isStandalone={isStandalone}
            onConfirm={handleSave}
            // Discard exits the wizard entirely and drops the user on the
            // Saucebook tab — replaces the previous "← Back to Dish Pairing"
            // link which was a confusing destination when review is the
            // entry screen for the edit flow.
            onDiscard={exitToSaucebook}
          />
        ) : null}

        {/* Step-aware footer — Continue + per-step Back link. Source has
            no Continue (cards advance themselves on Manual/URL/File pick).
            Review uses the embedded Save inside ReviewStep. */}
        {currentStep !== 'source' && currentStep !== 'review' ? (
          <View style={styles.card}>
            {!isStepValid(currentStep) ? (
              <View style={styles.errorBlock}>
                <Text style={styles.errorTitle}>Fix before continuing</Text>
                {validation.errors.map((e, i) => (
                  <Text key={i} style={styles.errorBullet}>• {e}</Text>
                ))}
              </View>
            ) : null}
            <TouchableOpacity
              style={[styles.saveBtn, !isStepValid(currentStep) && styles.btnDisabled]}
              onPress={goNext}
              disabled={!isStepValid(currentStep)}
              activeOpacity={0.85}
            >
              <Text style={styles.saveBtnLabel}>
                {returnToReview ? 'Back to Review' : 'Continue'}
              </Text>
            </TouchableOpacity>
            {prevStep(currentStep) ? (
              <TouchableOpacity
                style={styles.backLink}
                onPress={goBack}
                activeOpacity={0.7}
              >
                <Text style={styles.backLinkLabel}>
                  ← Back to {STEP_LABELS[prevStep(currentStep)]}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <IngredientEditorSheet
        visible={ingEditor != null}
        draft={ingEditor?.draft}
        isNew={ingEditor?.ii < 0}
        modifiers={state.ingredientModifiers}
        units={units}
        qualitativeUnits={qualitativeUnits}
        ingredientCategories={state.ingredientCategories}
        onChange={updateIngDraft}
        onSave={saveIngEditor}
        onCancel={() => setIngEditor(null)}
        onClassify={(category) => {
          if (ingEditor?.draft?.name) {
            actions.classifyIngredient(ingEditor.draft.name, category);
          }
        }}
      />

      <StepInputSheet
        visible={stepInputEditor != null}
        priorSteps={stepInputEditor ? builder.steps.slice(0, stepInputEditor.si) : []}
        draft={stepInputEditor?.draft || []}
        onToggle={toggleStepInputDraft}
        onSave={saveStepInputEditor}
        onCancel={() => setStepInputEditor(null)}
      />
    </KeyboardAvoidingView>
  );
}

