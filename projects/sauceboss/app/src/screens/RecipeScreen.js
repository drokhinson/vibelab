// Unified recipe view — handles both standalone (SauceManager) and
// meal-builder flows. When state.meal has item + sauce, the dish prep block
// is shown after the controls. Otherwise it's sauce-only.

import React, { useEffect, useMemo, useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Linking,
} from 'react-native';
// expo-file-system top-level export in SDK 54 dropped EncodingType — use
// the /legacy subpath (same as SauceBuilderScreen) to keep writeAsStringAsync.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Lightbulb, ChevronDown, Bookmark, BookmarkCheck, Download, ExternalLink, Pencil } from 'lucide-react-native';
import { useAppActions, useAppState } from '../store/AppContext';
import StepCard from '../components/StepCard';
import VariantSwitcher from '../components/VariantSwitcher';
import ServingsControl from '../components/ServingsControl';
import UnitToggle from '../components/UnitToggle';
import EmptyState from '../components/EmptyState';
import { api } from '../api/client';
import { SAUCE_TYPES, flowMetaFor } from '#shared/constants';
import { aggregateSauceIngredients, prepareItems, formatAmount } from '#shared/units';
import { capitalizeIngredient } from '#shared/text';
import { COLORS, SHADOWS } from '../theme';

export default function RecipeScreen({ navigation }) {
  const state = useAppState();
  const actions = useAppActions();
  const sauce = state.selectedSauce;

  // Meal-builder context
  const isMeal = !!(state.meal && state.meal.item && state.meal.sauce);
  const item = isMeal ? state.meal.item : null;
  const prep = isMeal ? state.meal.prep : null;

  const inSaucebook = !!(sauce && (state.saucebook?.items || []).some((s) => s.id === sauce.id));
  const isSignedIn = !!state.currentUser;

  const onToggleBookmark = useCallback(async () => {
    if (!sauce) return;
    if (!isSignedIn) {
      Alert.alert('Sign in to save recipes', 'Use the Settings tab to sign in, then tap the bookmark again.');
      return;
    }
    const res = inSaucebook
      ? await actions.removeFromSaucebook(sauce.id)
      : await actions.addToSaucebook(sauce);
    if (!res?.ok && res?.error) {
      Alert.alert('Saucebook', res.error);
    }
  }, [sauce, isSignedIn, inSaucebook, actions]);

  // Cooking mode — keeps the device screen on while the user follows the
  // recipe. Per-recipe toggle, off by default. The cleanup deactivates the
  // wake lock on unmount (back nav, screen swap, app backgrounded) so it
  // never leaks past the recipe view. Tag isolates this lock from other
  // screens that might use expo-keep-awake later.
  const KEEP_AWAKE_TAG = 'sauceboss-recipe';
  const [cookingMode, setCookingMode] = useState(false);
  useEffect(() => {
    if (cookingMode) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    }
    return () => deactivateKeepAwake(KEEP_AWAKE_TAG);
  }, [cookingMode]);

  const onToggleCookingMode = useCallback(() => {
    setCookingMode((prev) => !prev);
  }, []);

  const onDownload = useCallback(async () => {
    if (!sauce) return;
    try {
      const md = await api.exportSauceMd(sauce.id);
      const safeName = (sauce.name || 'sauce').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'sauce';
      const fileUri = `${FileSystem.cacheDirectory}${safeName}.md`;
      await FileSystem.writeAsStringAsync(fileUri, md, { encoding: FileSystem.EncodingType.UTF8 });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, { mimeType: 'text/markdown', dialogTitle: 'Download recipe' });
      } else {
        Alert.alert('Saved', `Recipe written to ${fileUri}`);
      }
    } catch (e) {
      Alert.alert('Download failed', e?.message || String(e));
    }
  }, [sauce]);

  // Header: title only. The navigator header stays pinned at the top
  // automatically; the action buttons live in a sticky in-body row
  // below it so the title row reads cleanly on its own.
  useEffect(() => {
    if (!sauce) return;
    navigation.setOptions({ title: sauce.name, headerRight: undefined });
  }, [sauce?.id, sauce?.name, navigation]);

  if (!sauce) {
    return (
      <View style={styles.screen}>
        <EmptyState
          body="Pick a sauce from the manager first."
          action="Open Sauce Manager"
          onAction={() => navigation.navigate('SauceManager')}
        />
      </View>
    );
  }

  const family = state.selectedSauceFamily;
  const meta = isMeal
    ? flowMetaFor(item)
    : SAUCE_TYPES.find((t) => t.value === (sauce.sauceType || 'sauce')) || SAUCE_TYPES[0];
  const isMarinade = sauce.sauceType === 'marinade';

  const sauceColor = isMarinade ? '#5D4037'
    : sauce.sauceType === 'dressing' ? '#1B5E20'
    : '#4A0072';

  const sauceLabel = isMeal
    ? `${meta.sauceWord} — ${sauce.name}`
    : `${meta.label} — ${sauce.name}`;

  const onPickVariant = (next) => {
    if (next.id === sauce.id) return;
    actions.selectVariant(next);
  };

  // Aggregated shopping-list view across all steps. Recomputed per
  // (sauce, servings, unitSystem) so scaling + unit toggles flow through.
  const aggregatedItems = useMemo(() => {
    const aggregated = aggregateSauceIngredients(sauce);
    if (!aggregated.length) return [];
    return prepareItems(aggregated, {
      servings: state.servings,
      unitSystem: state.unitSystem,
      baseServings: sauce.defaultServings || 2,
    });
  }, [sauce, state.servings, state.unitSystem]);

  // Item prep card (meal flow only)
  const itemSection = item ? (() => {
    const itemPrepLabel = item.category === 'salad'
      ? `🥗 Toss ${item.name}`
      : `${item.emoji} ${item.category === 'protein' ? 'Cook' : 'Prep'} ${item.name}${prep ? ` — ${prep.name}` : ''}`;
    const itemColor = item.category === 'protein' ? '#C94E02'
      : item.category === 'salad' ? '#2D6A4F'
      : '#1565C0';
    const itemCookTime = (prep?.cookTimeMinutes ?? item.cookTimeMinutes) || 0;
    const itemInstructions = prep?.instructions
      || item.instructions
      || (item.category === 'salad'
        ? `Toss ${item.name} with ${sauce.name} right before serving`
        : `Cook ${item.name} per packet instructions`);
    return (
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
  })() : null;

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
          baseServings={sauce.defaultServings || 2}
          disabledIngredients={state.disabledIngredients}
          substitutions={state.substitutions}
          hiddenSlices={state.hiddenPieSlices[i]}
          onTogglePieSlice={actions.togglePieSlice}
        />
      ))}
    </View>
  );

  const isAuthor = !!(state.currentUser?.id && sauce.createdBy && sauce.createdBy === state.currentUser.id);

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scrollBody}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.actionsRow}>
          <TouchableOpacity
            onPress={onDownload}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityLabel="Download recipe"
          >
            <Download size={22} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onToggleCookingMode}
            hitSlop={8}
            style={[styles.actionBtn, cookingMode && styles.actionBtnCookingOn]}
            accessibilityLabel={cookingMode ? 'Turn off cooking mode' : 'Keep screen on while cooking'}
          >
            <Lightbulb
              size={22}
              color={cookingMode ? '#1A1A1A' : COLORS.text}
              fill={cookingMode ? '#FFD60A' : 'none'}
            />
          </TouchableOpacity>
          {sauce.sourceUrl ? (
            <TouchableOpacity
              onPress={() => Linking.openURL(sauce.sourceUrl)}
              hitSlop={8}
              style={styles.actionBtn}
              accessibilityLabel="View original recipe"
            >
              <ExternalLink size={22} color={COLORS.text} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={onToggleBookmark}
            hitSlop={8}
            style={[styles.actionBtn, inSaucebook && styles.actionBtnActive]}
            accessibilityLabel={inSaucebook ? 'Remove from saucebook' : 'Save to saucebook'}
          >
            {inSaucebook ? (
              <BookmarkCheck size={22} color={COLORS.primary} />
            ) : (
              <Bookmark size={22} color={COLORS.text} />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.bodyPad}>
          {family && family.length > 1 ? (
            <View style={styles.variantWrap}>
              <VariantSwitcher family={family} currentId={sauce.id} onSelect={onPickVariant} />
            </View>
          ) : null}

          <View style={styles.controlsRow}>
            <ServingsControl value={state.servings} onChange={(v) => actions.setServings(v)} />
            <UnitToggle value={state.unitSystem} onChange={(v) => actions.setUnitSystem(v)} />
          </View>

          {aggregatedItems.length > 0 ? (
            <View style={styles.ingPanel}>
              <TouchableOpacity
                style={styles.ingPanelHeader}
                onPress={actions.toggleRecipeIngredients}
                activeOpacity={0.7}
              >
                <Text style={styles.ingPanelTitle}>
                  Ingredients · {aggregatedItems.length}
                </Text>
                <ChevronDown
                  size={16}
                  color={COLORS.textSecondary}
                  style={{
                    transform: [
                      { rotate: state.recipeIngredientsOpen ? '180deg' : '0deg' },
                    ],
                  }}
                />
              </TouchableOpacity>
              {state.recipeIngredientsOpen ? (
                <View style={styles.ingPanelBody}>
                  {aggregatedItems.map((it, i) => {
                    // Falsy amount → qualitative unit (to taste / splash /
                    // pinch / etc.). Render just the unit name, not "0 X".
                    const isQual = !it.amount;
                    return (
                      <View key={`${it.name}-${i}`} style={styles.ingPanelRow}>
                        <Text style={styles.ingPanelName} numberOfLines={1}>
                          {it.modifier ? `${capitalizeIngredient(it.modifier)} ` : ''}{capitalizeIngredient(it.name)}
                        </Text>
                        <Text style={styles.ingPanelQty}>
                          {isQual ? it.unit : `${formatAmount(it.amount)} ${it.unit}`}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : null}

          {isMeal && isMarinade ? (
            <>
              {sauceSection}
              {itemSection}
            </>
          ) : isMeal ? (
            <>
              {itemSection}
              {sauceSection}
            </>
          ) : (
            sauceSection
          )}

          {sauce.authorName ? (
            <View style={styles.footnote}>
              <Text style={styles.footnoteAuthor} numberOfLines={1}>
                Authored by {sauce.authorName}
              </Text>
              {isAuthor ? (
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => navigation.navigate('SauceBuilder', { sauceId: sauce.id })}
                  accessibilityLabel="Open this recipe in the editor"
                >
                  <Pencil size={14} color="#fff" />
                  <Text style={styles.editBtnText}>Edit recipe</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  scrollBody: {
    paddingBottom: 32,
  },
  // Sticky cluster of recipe action buttons. Sits as ScrollView child 0
  // with stickyHeaderIndices=[0] so it pins beneath the navigator header
  // while the rest of the recipe scrolls. Solid background occludes
  // content scrolling underneath.
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: COLORS.background,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.surfaceSubtle,
  },
  actionBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    ...SHADOWS.sm,
  },
  actionBtnActive: {
    backgroundColor: '#FFE6D1',
  },
  // Cooking-on halo — bright yellow pill with soft glow so the lit
  // lightbulb reads as unmistakably "on".
  actionBtnCookingOn: {
    backgroundColor: '#FFD60A',
    shadowColor: '#FFD60A',
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  bodyPad: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  variantWrap: {
    marginBottom: 8,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  ingPanel: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    marginBottom: 16,
    ...SHADOWS.sm,
    overflow: 'hidden',
  },
  ingPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  ingPanelTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.text,
    letterSpacing: 0.4,
  },
  ingPanelBody: {
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.surfaceSubtle,
  },
  ingPanelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.surfaceSubtle,
  },
  ingPanelName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
    marginRight: 8,
  },
  ingPanelQty: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
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
  footnote: {
    marginTop: 24,
    paddingTop: 16,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: COLORS.surfaceSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  footnoteAuthor: {
    flex: 1,
    fontSize: 13,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: COLORS.primary,
    minHeight: 36,
  },
  editBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
});
