// Central app state — mirrors web/state.js shape. Reducer + provider.
// Read context and dispatch are split so screens that only dispatch don't
// re-render on read changes.

import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, setAuthTokenGetter } from '../api/client';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { signInWithGoogleOAuth } from '../auth/oauth';
import { withIngredientNames } from '#shared/filter';

// ── Initial state ───────────────────────────────────────────────────────────
export const initialState = {
  // Boot status
  bootError: null,
  initialLoaded: false,

  // Initial-load lists
  carbs: [],
  proteins: [],
  saladBases: [],

  // Active home tab
  mealCategory: 'carbs',

  // Current selection flow
  selectedItem: null,
  selectedPrep: null,
  preparations: [],
  saucesForCurrentItem: [],
  allIngredients: [],
  itemLoading: false,
  itemError: null,

  selectedSauce: null,
  selectedSauceFamily: [],
  servings: 2,
  unitSystem: 'imperial', // 'imperial' | 'metric'

  // Reference data — loaded from backend on boot (see boot useEffect below).
  // Cuisines ← GET /api/v1/sauceboss/cuisines  (DB: sauceboss_cuisine_info)
  // Units    ← GET /api/v1/sauceboss/units      (DB: sauceboss_unit)
  refCuisines: [],              // [{ cuisine, emoji }]
  refUnits: [],                 // [{ id, abbreviation, quantifiable, ... }]
  ingredientCategories: {},
  ingredientModifiers: [],      // [{ id, name }] — prep states like "minced"
  substitutions: {},

  // Recipe-screen UI state (collapsible Ingredients summary + per-step pie
  // chart toggles). `hiddenPieSlices[stepIndex]` is a Set of ingredient
  // names hidden in that step's chart + legend. Cleared on SELECT_SAUCE so
  // toggles don't bleed across recipes.
  recipeIngredientsOpen: false,
  hiddenPieSlices: {},

  // Filter state
  disabledIngredients: new Set(),
  filterOpen: false,
  expandedCuisines: new Set(),

  // Final meal (set when sauce is picked)
  meal: { item: null, prep: null, sauce: null },

  // Sauce Manager (browse-all view; independent of the meal flow)
  managerTab: 'sauces',              // 'sauces' | 'dish' | 'ingredients'
  managerSauces: [],
  managerLoading: false,
  managerError: null,
  managerSearch: '',
  managerTypeFilter: 'all',          // 'all' | 'sauce' | 'marinade' | 'dressing'
  managerExpandedCuisines: new Set(),
  // Admin "long-press a sauce → mark others as variants of it" merge mode.
  sauceMerge: null,                   // { keepId, mergeIds: Set, error, saving } when admin is merging

  // Manager → Dish tab
  managerItems: { carbs: [], proteins: [], salads: [] },
  managerItemsLoading: false,
  managerItemsError: null,
  expandedItemSections: new Set(),    // 'carbs' | 'proteins' | 'salads'
  expandedItemParents: new Set(),     // item ids whose variant list is open

  // Manager → Ingredients tab
  managerIngredients: [],             // [{ id, name, plural, usageCount, sauceCount }]
  managerIngredientsLoading: false,
  managerIngredientsError: null,
  expandedIngredientSections: new Set(), // category names
  expandedIngredientIds: new Set(),   // ingredient ids whose sauces panel is open
  ingredientMerge: null,              // { keepId, mergeIds: Set, error, saving } when admin is in merge mode

  // Auth (Phase 2 hooks; unused in Phase 1)
  authReady: false,             // false until we've checked supabase for an existing session
  authBusy: false,              // true while a sign-in / sign-up is in flight
  authError: null,
  becomeAdminBusy: false,
  becomeAdminError: null,
  session: null,
  currentUser: null,

  // Edit mode — gates editorial UI in the Sauce Manager (Edit / Delete /
  // Download / Merge per-row actions, the `+` FAB, the admin bulk-export
  // button at the bottom of the list). Mirrors the web's `state.editMode`.
  // Defaults to false; flipped by the pencil toggle in the manager header
  // (visible only to logged-in users); reset to false on sign-out.
  editMode: false,

  // ── Three-tab home (Browse / Saucebook / Pantry) ──────────────────────────
  // Browse: paginated public-discovery list. Filters compound; page resets
  // to 0 on any filter change. Sets are used for multi-select chips so the
  // shape matches expandedCuisines / disabledIngredients elsewhere.
  browse: {
    items: [],
    total: 0,
    page: 0,
    pageSize: 20,
    loading: false,
    loaded: false,
    error: null,
    q: '',
    cuisines: new Set(),
    types: new Set(),
    dishes: new Set(),
    authorId: null,
    authorQuery: '',
    authorResults: [],
    filtersOpen: false,
  },

  // Saucebook: the user's personal library. Lightweight rows (no steps).
  // Each row has `ingredientNames: Set<string>` (attached by shared/api.js).
  saucebook: {
    items: [],
    loading: false,
    loaded: false,
    error: null,
    search: '',
    filters: {
      open: false,
      cuisines: new Set(),
      types: new Set(),
      dishes: new Set(),
      authorId: null,
    },
  },
  cuisineSections: {}, // { [cuisine]: bool } — saucebook accordion open state

  // Pantry: user's negative ingredient list, derived from saucebook
  // ingredients. `missing` flags two-way sync with `disabledIngredients`
  // (which is the meal-builder filter Set keyed by ingredient name).
  pantry: {
    ingredients: [], // [{ ingredientId, name, plural, category, missing }]
    saucebookSauceIds: [],
    loading: false,
    loaded: false,
    error: null,
    openSections: new Set(),
  },
};

// ── Action types ────────────────────────────────────────────────────────────
const A = {
  BOOT_LOADED: 'BOOT_LOADED',
  BOOT_ERROR: 'BOOT_ERROR',
  SET_INGREDIENT_CATEGORIES: 'SET_INGREDIENT_CATEGORIES',
  SET_INGREDIENT_CATEGORY: 'SET_INGREDIENT_CATEGORY',
  SET_INGREDIENT_MODIFIERS: 'SET_INGREDIENT_MODIFIERS',
  SET_SUBSTITUTIONS: 'SET_SUBSTITUTIONS',
  SET_MEAL_CATEGORY: 'SET_MEAL_CATEGORY',
  TOGGLE_PIE_SLICE: 'TOGGLE_PIE_SLICE',
  TOGGLE_RECIPE_INGREDIENTS: 'TOGGLE_RECIPE_INGREDIENTS',

  ITEM_SELECT_START: 'ITEM_SELECT_START',
  ITEM_LOADED: 'ITEM_LOADED',
  ITEM_LOAD_ERROR: 'ITEM_LOAD_ERROR',
  CLEAR_ITEM: 'CLEAR_ITEM',

  SET_PREP: 'SET_PREP',

  TOGGLE_INGREDIENT: 'TOGGLE_INGREDIENT',
  CLEAR_INGREDIENT_FILTER: 'CLEAR_INGREDIENT_FILTER',
  SET_FILTER_OPEN: 'SET_FILTER_OPEN',
  TOGGLE_CUISINE: 'TOGGLE_CUISINE',

  SELECT_SAUCE: 'SELECT_SAUCE',
  SET_SERVINGS: 'SET_SERVINGS',
  SET_UNIT_SYSTEM: 'SET_UNIT_SYSTEM',
  SELECT_VARIANT: 'SELECT_VARIANT',

  // Sauce Manager — browse-all view
  MANAGER_LOAD_START: 'MANAGER_LOAD_START',
  MANAGER_LOADED: 'MANAGER_LOADED',
  MANAGER_LOAD_ERROR: 'MANAGER_LOAD_ERROR',
  MANAGER_SET_SEARCH: 'MANAGER_SET_SEARCH',
  MANAGER_SET_TYPE_FILTER: 'MANAGER_SET_TYPE_FILTER',
  MANAGER_TOGGLE_CUISINE: 'MANAGER_TOGGLE_CUISINE',
  MANAGER_REMOVE_SAUCE: 'MANAGER_REMOVE_SAUCE',
  MANAGER_UPSERT_SAUCE: 'MANAGER_UPSERT_SAUCE',
  MANAGER_SET_TAB: 'MANAGER_SET_TAB',
  SAUCE_MERGE_START: 'SAUCE_MERGE_START',
  SAUCE_MERGE_TOGGLE_PICK: 'SAUCE_MERGE_TOGGLE_PICK',
  SAUCE_MERGE_CANCEL: 'SAUCE_MERGE_CANCEL',
  SAUCE_MERGE_SET_ERROR: 'SAUCE_MERGE_SET_ERROR',

  // Manager → Dish tab
  ITEMS_LOAD_START: 'ITEMS_LOAD_START',
  ITEMS_LOADED: 'ITEMS_LOADED',
  ITEMS_LOAD_ERROR: 'ITEMS_LOAD_ERROR',
  ITEMS_TOGGLE_SECTION: 'ITEMS_TOGGLE_SECTION',
  ITEMS_TOGGLE_PARENT: 'ITEMS_TOGGLE_PARENT',

  // Manager → Ingredients tab
  INGREDIENTS_LOAD_START: 'INGREDIENTS_LOAD_START',
  INGREDIENTS_LOADED: 'INGREDIENTS_LOADED',
  INGREDIENTS_LOAD_ERROR: 'INGREDIENTS_LOAD_ERROR',
  INGREDIENTS_TOGGLE_SECTION: 'INGREDIENTS_TOGGLE_SECTION',
  INGREDIENTS_TOGGLE_EXPAND: 'INGREDIENTS_TOGGLE_EXPAND',
  INGREDIENTS_REMOVE: 'INGREDIENTS_REMOVE',
  INGREDIENT_MERGE_START: 'INGREDIENT_MERGE_START',
  INGREDIENT_MERGE_TOGGLE_PICK: 'INGREDIENT_MERGE_TOGGLE_PICK',
  INGREDIENT_MERGE_CANCEL: 'INGREDIENT_MERGE_CANCEL',
  INGREDIENT_MERGE_SET_ERROR: 'INGREDIENT_MERGE_SET_ERROR',

  // Phase 2 hooks (auth). Not used in Phase 1 but reducer handles them so wiring later is trivial.
  SET_REF_CUISINES: 'SET_REF_CUISINES',
  SET_REF_UNITS: 'SET_REF_UNITS',
  SET_AUTH_READY: 'SET_AUTH_READY',
  SET_AUTH_BUSY: 'SET_AUTH_BUSY',
  SET_AUTH_ERROR: 'SET_AUTH_ERROR',
  SET_SESSION: 'SET_SESSION',
  SET_CURRENT_USER: 'SET_CURRENT_USER',
  SET_BECOME_ADMIN_BUSY: 'SET_BECOME_ADMIN_BUSY',
  SET_BECOME_ADMIN_ERROR: 'SET_BECOME_ADMIN_ERROR',
  CLEAR_AUTH: 'CLEAR_AUTH',

  TOGGLE_EDIT_MODE: 'TOGGLE_EDIT_MODE',

  // ── Three-tab home ───────────────────────────────────────────────────────
  BROWSE_LOAD_START: 'BROWSE_LOAD_START',
  BROWSE_LOADED: 'BROWSE_LOADED',
  BROWSE_LOAD_ERROR: 'BROWSE_LOAD_ERROR',
  BROWSE_SET_SEARCH: 'BROWSE_SET_SEARCH',
  BROWSE_TOGGLE_FILTER: 'BROWSE_TOGGLE_FILTER', // payload: { key: 'cuisines'|'types'|'dishes', value }
  BROWSE_SET_AUTHOR: 'BROWSE_SET_AUTHOR',
  BROWSE_SET_AUTHOR_QUERY: 'BROWSE_SET_AUTHOR_QUERY',
  BROWSE_SET_AUTHOR_RESULTS: 'BROWSE_SET_AUTHOR_RESULTS',
  BROWSE_SET_PAGE: 'BROWSE_SET_PAGE',
  BROWSE_TOGGLE_FILTERS_OPEN: 'BROWSE_TOGGLE_FILTERS_OPEN',
  BROWSE_CLEAR_FILTERS: 'BROWSE_CLEAR_FILTERS',
  BROWSE_MARK_IN_SAUCEBOOK: 'BROWSE_MARK_IN_SAUCEBOOK',

  SAUCEBOOK_LOAD_START: 'SAUCEBOOK_LOAD_START',
  SAUCEBOOK_LOADED: 'SAUCEBOOK_LOADED',
  SAUCEBOOK_LOAD_ERROR: 'SAUCEBOOK_LOAD_ERROR',
  SAUCEBOOK_ADD: 'SAUCEBOOK_ADD',
  SAUCEBOOK_REMOVE: 'SAUCEBOOK_REMOVE',
  SAUCEBOOK_SET_SEARCH: 'SAUCEBOOK_SET_SEARCH',
  SAUCEBOOK_TOGGLE_FILTER: 'SAUCEBOOK_TOGGLE_FILTER',
  SAUCEBOOK_CLEAR_FILTERS: 'SAUCEBOOK_CLEAR_FILTERS',
  SAUCEBOOK_TOGGLE_FILTERS_OPEN: 'SAUCEBOOK_TOGGLE_FILTERS_OPEN',
  SAUCEBOOK_SET_AUTHOR: 'SAUCEBOOK_SET_AUTHOR',
  SAUCEBOOK_TOGGLE_CUISINE_SECTION: 'SAUCEBOOK_TOGGLE_CUISINE_SECTION',
  SAUCEBOOK_SET_ALL_CUISINE_SECTIONS: 'SAUCEBOOK_SET_ALL_CUISINE_SECTIONS',

  PANTRY_LOAD_START: 'PANTRY_LOAD_START',
  PANTRY_LOADED: 'PANTRY_LOADED',
  PANTRY_LOAD_ERROR: 'PANTRY_LOAD_ERROR',
  PANTRY_TOGGLE_MISSING: 'PANTRY_TOGGLE_MISSING',
  PANTRY_TOGGLE_SECTION: 'PANTRY_TOGGLE_SECTION',
  PANTRY_RESTOCK_ALL: 'PANTRY_RESTOCK_ALL',
  PANTRY_SET_ALL_SECTIONS: 'PANTRY_SET_ALL_SECTIONS',
};

// ── Reducer ─────────────────────────────────────────────────────────────────
function reducer(state, action) {
  switch (action.type) {
    case A.BOOT_LOADED:
      return {
        ...state,
        carbs: action.carbs || [],
        proteins: action.proteins || [],
        saladBases: action.saladBases || [],
        initialLoaded: true,
        bootError: null,
      };
    case A.BOOT_ERROR:
      return { ...state, bootError: action.error, initialLoaded: false };

    case A.SET_REF_CUISINES:
      return { ...state, refCuisines: action.payload || [] };
    case A.SET_REF_UNITS:
      return { ...state, refUnits: action.payload || [] };

    case A.SET_INGREDIENT_CATEGORIES:
      return { ...state, ingredientCategories: action.payload || {} };

    case A.SET_INGREDIENT_CATEGORY: {
      const next = { ...(state.ingredientCategories || {}) };
      next[action.name] = action.category;
      return { ...state, ingredientCategories: next };
    }

    case A.SET_INGREDIENT_MODIFIERS:
      return { ...state, ingredientModifiers: action.payload || [] };

    case A.SET_SUBSTITUTIONS:
      return { ...state, substitutions: action.payload || {} };

    case A.TOGGLE_PIE_SLICE: {
      const { stepIndex, name } = action;
      const current = state.hiddenPieSlices[stepIndex] || new Set();
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return {
        ...state,
        hiddenPieSlices: { ...state.hiddenPieSlices, [stepIndex]: next },
      };
    }

    case A.TOGGLE_RECIPE_INGREDIENTS:
      return { ...state, recipeIngredientsOpen: !state.recipeIngredientsOpen };

    case A.SET_MEAL_CATEGORY:
      return { ...state, mealCategory: action.payload };

    case A.ITEM_SELECT_START:
      return {
        ...state,
        selectedItem: action.item,
        selectedPrep: null,
        preparations: [],
        saucesForCurrentItem: [],
        allIngredients: [],
        disabledIngredients: new Set(),
        filterOpen: false,
        expandedCuisines: new Set(),
        servings: 2,
        itemLoading: true,
        itemError: null,
      };

    case A.ITEM_LOADED:
      return {
        ...state,
        selectedItem: action.item || state.selectedItem,
        preparations: action.variants || [],
        saucesForCurrentItem: action.sauces || [],
        allIngredients: action.ingredients || [],
        itemLoading: false,
        itemError: null,
      };

    case A.ITEM_LOAD_ERROR:
      return { ...state, itemLoading: false, itemError: action.error };

    case A.CLEAR_ITEM:
      return {
        ...state,
        selectedItem: null,
        selectedPrep: null,
        preparations: [],
        saucesForCurrentItem: [],
        allIngredients: [],
        disabledIngredients: new Set(),
        filterOpen: false,
        expandedCuisines: new Set(),
        servings: 2,
        meal: { item: null, prep: null, sauce: null },
      };

    case A.SET_PREP:
      return { ...state, selectedPrep: action.prep };

    case A.TOGGLE_INGREDIENT: {
      const next = new Set(state.disabledIngredients);
      if (next.has(action.name)) next.delete(action.name);
      else next.add(action.name);
      return { ...state, disabledIngredients: next };
    }

    case A.CLEAR_INGREDIENT_FILTER:
      return { ...state, disabledIngredients: new Set() };

    case A.SET_FILTER_OPEN:
      return { ...state, filterOpen: action.open };

    case A.TOGGLE_CUISINE: {
      const next = new Set(state.expandedCuisines);
      if (next.has(action.cuisine)) next.delete(action.cuisine);
      else next.add(action.cuisine);
      return { ...state, expandedCuisines: next };
    }

    case A.SELECT_SAUCE:
      return {
        ...state,
        selectedSauce: action.sauce,
        selectedSauceFamily: action.family || [],
        servings: action.sauce?.defaultServings || 2,
        hiddenPieSlices: {},
        meal: {
          item: state.selectedItem,
          prep: state.selectedPrep,
          sauce: action.sauce,
        },
      };

    case A.SELECT_VARIANT: {
      const sauce = action.sauce;
      return {
        ...state,
        selectedSauce: sauce,
        servings: sauce?.defaultServings || 2,
        hiddenPieSlices: {},
        meal: { ...state.meal, sauce },
      };
    }

    case A.SET_SERVINGS:
      return { ...state, servings: Math.max(1, Math.min(12, action.value)) };

    case A.SET_UNIT_SYSTEM:
      return { ...state, unitSystem: action.value === 'metric' ? 'metric' : 'imperial' };

    case A.MANAGER_LOAD_START:
      return { ...state, managerLoading: true, managerError: null };

    case A.MANAGER_LOADED:
      return { ...state, managerSauces: action.sauces || [], managerLoading: false, managerError: null };

    case A.MANAGER_LOAD_ERROR:
      return { ...state, managerLoading: false, managerError: action.error };

    case A.MANAGER_SET_SEARCH:
      return { ...state, managerSearch: action.value || '' };

    case A.MANAGER_SET_TYPE_FILTER:
      return { ...state, managerTypeFilter: action.value || 'all' };

    case A.MANAGER_TOGGLE_CUISINE: {
      const next = new Set(state.managerExpandedCuisines);
      if (next.has(action.cuisine)) next.delete(action.cuisine);
      else next.add(action.cuisine);
      return { ...state, managerExpandedCuisines: next };
    }

    case A.MANAGER_REMOVE_SAUCE:
      return { ...state, managerSauces: state.managerSauces.filter((s) => s.id !== action.sauceId) };

    case A.MANAGER_UPSERT_SAUCE: {
      const idx = state.managerSauces.findIndex((s) => s.id === action.sauce.id);
      const next = state.managerSauces.slice();
      if (idx >= 0) next[idx] = action.sauce;
      else next.unshift(action.sauce);
      return { ...state, managerSauces: next };
    }

    case A.MANAGER_SET_TAB:
      return { ...state, managerTab: action.value, managerSearch: '' };

    case A.SAUCE_MERGE_START:
      return {
        ...state,
        sauceMerge: { keepId: action.keepId, mergeIds: new Set(), error: null, saving: false },
      };

    case A.SAUCE_MERGE_TOGGLE_PICK: {
      if (!state.sauceMerge) return state;
      const next = new Set(state.sauceMerge.mergeIds);
      if (next.has(action.sauceId)) next.delete(action.sauceId);
      else next.add(action.sauceId);
      return { ...state, sauceMerge: { ...state.sauceMerge, mergeIds: next, error: null } };
    }

    case A.SAUCE_MERGE_CANCEL:
      return { ...state, sauceMerge: null };

    case A.SAUCE_MERGE_SET_ERROR:
      return state.sauceMerge
        ? { ...state, sauceMerge: { ...state.sauceMerge, error: action.error, saving: !!action.saving } }
        : state;

    case A.ITEMS_LOAD_START:
      return { ...state, managerItemsLoading: true, managerItemsError: null };

    case A.ITEMS_LOADED:
      return {
        ...state,
        managerItems: action.items || { carbs: [], proteins: [], salads: [] },
        managerItemsLoading: false,
        managerItemsError: null,
      };

    case A.ITEMS_LOAD_ERROR:
      return { ...state, managerItemsLoading: false, managerItemsError: action.error };

    case A.ITEMS_TOGGLE_SECTION: {
      const next = new Set(state.expandedItemSections);
      if (next.has(action.category)) next.delete(action.category);
      else next.add(action.category);
      return { ...state, expandedItemSections: next };
    }

    case A.ITEMS_TOGGLE_PARENT: {
      const next = new Set(state.expandedItemParents);
      if (next.has(action.parentId)) next.delete(action.parentId);
      else next.add(action.parentId);
      return { ...state, expandedItemParents: next };
    }

    case A.INGREDIENTS_LOAD_START:
      return { ...state, managerIngredientsLoading: true, managerIngredientsError: null };

    case A.INGREDIENTS_LOADED:
      return {
        ...state,
        managerIngredients: action.ingredients || [],
        managerIngredientsLoading: false,
        managerIngredientsError: null,
      };

    case A.INGREDIENTS_LOAD_ERROR:
      return { ...state, managerIngredientsLoading: false, managerIngredientsError: action.error };

    case A.INGREDIENTS_TOGGLE_SECTION: {
      const next = new Set(state.expandedIngredientSections);
      if (next.has(action.category)) next.delete(action.category);
      else next.add(action.category);
      return { ...state, expandedIngredientSections: next };
    }

    case A.INGREDIENTS_TOGGLE_EXPAND: {
      const next = new Set(state.expandedIngredientIds);
      if (next.has(action.ingredientId)) next.delete(action.ingredientId);
      else next.add(action.ingredientId);
      return { ...state, expandedIngredientIds: next };
    }

    case A.INGREDIENTS_REMOVE:
      return { ...state, managerIngredients: state.managerIngredients.filter((f) => f.id !== action.ingredientId) };

    case A.INGREDIENT_MERGE_START:
      return {
        ...state,
        ingredientMerge: { keepId: action.keepId, mergeIds: new Set(), error: null, saving: false },
      };

    case A.INGREDIENT_MERGE_TOGGLE_PICK: {
      if (!state.ingredientMerge) return state;
      const next = new Set(state.ingredientMerge.mergeIds);
      if (next.has(action.ingredientId)) next.delete(action.ingredientId);
      else next.add(action.ingredientId);
      return { ...state, ingredientMerge: { ...state.ingredientMerge, mergeIds: next, error: null } };
    }

    case A.INGREDIENT_MERGE_CANCEL:
      return { ...state, ingredientMerge: null };

    case A.INGREDIENT_MERGE_SET_ERROR:
      return state.ingredientMerge
        ? { ...state, ingredientMerge: { ...state.ingredientMerge, error: action.error, saving: !!action.saving } }
        : state;

    case A.SET_AUTH_READY:
      return { ...state, authReady: !!action.value };

    case A.SET_AUTH_BUSY:
      return { ...state, authBusy: !!action.value };

    case A.SET_AUTH_ERROR:
      return { ...state, authError: action.error || null };

    case A.SET_SESSION:
      return { ...state, session: action.session };

    case A.SET_CURRENT_USER:
      // Sign-out path also clears edit mode so the next sign-in starts in
      // the read-only browse view.
      return action.user
        ? { ...state, currentUser: action.user }
        : { ...state, currentUser: null, editMode: false };

    case A.TOGGLE_EDIT_MODE:
      // Anonymous users never see the toggle, but guard here in case the
      // action is dispatched after a sign-out racy edge case.
      return state.currentUser ? { ...state, editMode: !state.editMode } : state;

    case A.SET_BECOME_ADMIN_BUSY:
      return { ...state, becomeAdminBusy: !!action.value };

    case A.SET_BECOME_ADMIN_ERROR:
      return { ...state, becomeAdminError: action.error || null };

    case A.CLEAR_AUTH:
      return {
        ...state,
        session: null,
        currentUser: null,
        authError: null,
        becomeAdminError: null,
        editMode: false,
        // Drop any per-user data so the next sign-in starts clean.
        saucebook: { ...state.saucebook, items: [], loaded: false },
        pantry: { ...state.pantry, ingredients: [], saucebookSauceIds: [], loaded: false },
      };

    // ── Browse ────────────────────────────────────────────────────────────
    case A.BROWSE_LOAD_START:
      return { ...state, browse: { ...state.browse, loading: true, error: null } };

    case A.BROWSE_LOADED:
      return {
        ...state,
        browse: {
          ...state.browse,
          items: action.items || [],
          total: action.total || 0,
          loading: false,
          loaded: true,
          error: null,
        },
      };

    case A.BROWSE_LOAD_ERROR:
      return { ...state, browse: { ...state.browse, loading: false, error: action.error } };

    case A.BROWSE_SET_SEARCH:
      // Reset page to 0 on any search change so results stay coherent.
      return { ...state, browse: { ...state.browse, q: action.value || '', page: 0 } };

    case A.BROWSE_TOGGLE_FILTER: {
      const { key, value } = action;
      const current = state.browse[key] || new Set();
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...state, browse: { ...state.browse, [key]: next, page: 0 } };
    }

    case A.BROWSE_SET_AUTHOR:
      return {
        ...state,
        browse: {
          ...state.browse,
          authorId: action.authorId || null,
          authorQuery: action.authorQuery ?? state.browse.authorQuery,
          page: 0,
        },
      };

    case A.BROWSE_SET_AUTHOR_QUERY:
      return { ...state, browse: { ...state.browse, authorQuery: action.value || '' } };

    case A.BROWSE_SET_AUTHOR_RESULTS:
      return { ...state, browse: { ...state.browse, authorResults: action.results || [] } };

    case A.BROWSE_SET_PAGE:
      return { ...state, browse: { ...state.browse, page: Math.max(0, action.page | 0) } };

    case A.BROWSE_TOGGLE_FILTERS_OPEN:
      return { ...state, browse: { ...state.browse, filtersOpen: !state.browse.filtersOpen } };

    case A.BROWSE_CLEAR_FILTERS:
      return {
        ...state,
        browse: {
          ...state.browse,
          q: '',
          cuisines: new Set(),
          types: new Set(),
          dishes: new Set(),
          authorId: null,
          authorQuery: '',
          page: 0,
        },
      };

    case A.BROWSE_MARK_IN_SAUCEBOOK: {
      const items = state.browse.items.map((s) =>
        s.id === action.sauceId ? { ...s, inSaucebook: !!action.value } : s,
      );
      return { ...state, browse: { ...state.browse, items } };
    }

    // ── Saucebook ─────────────────────────────────────────────────────────
    case A.SAUCEBOOK_LOAD_START:
      return { ...state, saucebook: { ...state.saucebook, loading: true, error: null } };

    case A.SAUCEBOOK_LOADED:
      return {
        ...state,
        saucebook: {
          ...state.saucebook,
          items: action.items || [],
          loading: false,
          loaded: true,
          error: null,
        },
      };

    case A.SAUCEBOOK_LOAD_ERROR:
      // `loaded: true` so the screen can distinguish "never tried" from
      // "tried and failed" — the loading spinner clears and the error
      // empty-state surfaces.
      return { ...state, saucebook: { ...state.saucebook, loading: false, loaded: true, error: action.error } };

    case A.SAUCEBOOK_ADD: {
      // Optimistic add — caller passes the row to splice in.
      const exists = state.saucebook.items.some((s) => s.id === action.sauce?.id);
      if (exists || !action.sauce) return state;
      return {
        ...state,
        saucebook: { ...state.saucebook, items: [action.sauce, ...state.saucebook.items] },
      };
    }

    case A.SAUCEBOOK_REMOVE:
      return {
        ...state,
        saucebook: {
          ...state.saucebook,
          items: state.saucebook.items.filter((s) => s.id !== action.sauceId),
        },
      };

    case A.SAUCEBOOK_SET_SEARCH:
      return { ...state, saucebook: { ...state.saucebook, search: action.value || '' } };

    case A.SAUCEBOOK_TOGGLE_FILTER: {
      const { key, value } = action;
      const current = state.saucebook.filters[key] || new Set();
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return {
        ...state,
        saucebook: {
          ...state.saucebook,
          filters: { ...state.saucebook.filters, [key]: next },
        },
      };
    }

    case A.SAUCEBOOK_SET_AUTHOR:
      return {
        ...state,
        saucebook: {
          ...state.saucebook,
          filters: { ...state.saucebook.filters, authorId: action.authorId || null },
        },
      };

    // Wipe every filter chip + author selection on the saucebook list.
    // Mirrors the Browse clearBrowseFilters action. Leaves `open` and the
    // search box alone so the filter panel stays where the user put it.
    case A.SAUCEBOOK_CLEAR_FILTERS:
      return {
        ...state,
        saucebook: {
          ...state.saucebook,
          filters: {
            ...state.saucebook.filters,
            cuisines: new Set(),
            types: new Set(),
            dishes: new Set(),
            authorId: null,
          },
        },
      };

    case A.SAUCEBOOK_TOGGLE_FILTERS_OPEN:
      return {
        ...state,
        saucebook: {
          ...state.saucebook,
          filters: { ...state.saucebook.filters, open: !state.saucebook.filters.open },
        },
      };

    case A.SAUCEBOOK_TOGGLE_CUISINE_SECTION: {
      const cuisine = action.cuisine;
      const prev = state.cuisineSections[cuisine];
      // Default is open; toggling explicitly stores false. Subsequent toggles flip.
      return {
        ...state,
        cuisineSections: {
          ...state.cuisineSections,
          [cuisine]: prev === undefined ? false : !prev,
        },
      };
    }

    // Bulk collapse / expand. `cuisines` is the caller-supplied visible set
    // (typically the current grouped list). `value` is the new open state —
    // true means expand all, false means collapse all.
    case A.SAUCEBOOK_SET_ALL_CUISINE_SECTIONS: {
      const next = { ...state.cuisineSections };
      for (const c of (action.cuisines || [])) {
        next[c] = !!action.value;
      }
      return { ...state, cuisineSections: next };
    }

    // ── Pantry ────────────────────────────────────────────────────────────
    case A.PANTRY_LOAD_START:
      return { ...state, pantry: { ...state.pantry, loading: true, error: null } };

    case A.PANTRY_LOADED: {
      const ingredients = action.ingredients || [];
      // Mirror the missing set into disabledIngredients (keyed by name) so
      // the meal-builder filter stays in sync.
      const disabled = new Set();
      for (const i of ingredients) {
        if (i.missing) disabled.add(i.name);
      }
      return {
        ...state,
        pantry: {
          ...state.pantry,
          ingredients,
          saucebookSauceIds: action.saucebookSauceIds || [],
          loading: false,
          loaded: true,
          error: null,
        },
        disabledIngredients: disabled,
      };
    }

    case A.PANTRY_LOAD_ERROR:
      return { ...state, pantry: { ...state.pantry, loading: false, error: action.error } };

    case A.PANTRY_TOGGLE_MISSING: {
      const id = action.ingredientId;
      const ingredients = state.pantry.ingredients.map((i) =>
        i.ingredientId === id ? { ...i, missing: !i.missing } : i,
      );
      // Keep disabledIngredients in lock-step with the toggle.
      const disabled = new Set();
      for (const i of ingredients) {
        if (i.missing) disabled.add(i.name);
      }
      return {
        ...state,
        pantry: { ...state.pantry, ingredients },
        disabledIngredients: disabled,
      };
    }

    case A.PANTRY_TOGGLE_SECTION: {
      const next = new Set(state.pantry.openSections);
      if (next.has(action.category)) next.delete(action.category);
      else next.add(action.category);
      return { ...state, pantry: { ...state.pantry, openSections: next } };
    }

    // Mark every pantry ingredient as in-stock and clear the disabled set.
    // The "Restock" button on the pantry header fires this so the user can
    // reset filters with one tap after a grocery trip.
    case A.PANTRY_RESTOCK_ALL: {
      const ingredients = state.pantry.ingredients.map((i) =>
        i.missing ? { ...i, missing: false } : i,
      );
      return {
        ...state,
        pantry: { ...state.pantry, ingredients },
        disabledIngredients: new Set(),
      };
    }

    // Bulk-collapse / bulk-expand every visible category in one shot. The
    // pantry header's collapse-all toggle dispatches this with the current
    // visible category list + the target value.
    case A.PANTRY_SET_ALL_SECTIONS: {
      const next = action.value
        ? new Set(action.categories || [])
        : new Set();
      return { ...state, pantry: { ...state.pantry, openSections: next } };
    }

    default:
      return state;
  }
}

// ── Contexts (split read/write) ─────────────────────────────────────────────
const StateContext = createContext(initialState);
const DispatchContext = createContext(null);
const ActionsContext = createContext(null);

export function useAppState() {
  return useContext(StateContext);
}
export function useAppDispatch() {
  return useContext(DispatchContext);
}
export function useAppActions() {
  return useContext(ActionsContext);
}

// ── Provider ────────────────────────────────────────────────────────────────
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Wire the API client to read the auth token directly from the Supabase
  // client (not from React state). Going through stateRef.current.session
  // raced the SET_SESSION dispatch — onAuthStateChange fires, dispatches
  // SET_SESSION, then synchronously kicks off hydrateUserState → api.getProfile,
  // but stateRef only updates after the next render commits. The first
  // profile fetch went out unauthenticated, currentUser never got set, and
  // the user had to re-sign-in for the followup attempt to land on a
  // populated stateRef.
  //
  // supabase.auth.getSession() is in-memory after the first call, so this
  // adds no measurable latency to authenticated requests.
  useEffect(() => {
    setAuthTokenGetter(async () => {
      if (!supabase) return null;
      try {
        const { data } = await supabase.auth.getSession();
        return data?.session?.access_token || null;
      } catch {
        return null;
      }
    });
  }, []);

  // Auth bootstrap: subscribe to Supabase session changes. On sign-in, fetch
  // profile (auto-create on 404). On sign-out, clear it.
  useEffect(() => {
    if (!isAuthConfigured || !supabase) {
      // No Supabase config — auth is not available; mark ready so UI doesn't hang.
      dispatch({ type: A.SET_AUTH_READY, value: true });
      return undefined;
    }

    let cancelled = false;

    async function hydrateUserState(session) {
      if (!session) {
        dispatch({ type: A.CLEAR_AUTH });
        return;
      }
      // Profile: 404 means auto-create. Any other failure means the Supabase
      // session is good but our backend rejected the request — keep
      // currentUser null and surface the message via authError so the user
      // doesn't see a stuck "Sign in" button without explanation.
      try {
        const profile = await api.getProfile();
        if (!cancelled) {
          dispatch({
            type: A.SET_CURRENT_USER,
            user: { user_id: profile.id, display_name: profile.display_name, is_admin: !!profile.is_admin },
          });
        }
      } catch (e) {
        if (e.status === 404) {
          try {
            const created = await api.upsertProfile(session.user?.email?.split('@')[0] || 'Saucier');
            if (!cancelled) {
              dispatch({
                type: A.SET_CURRENT_USER,
                user: { user_id: created.id, display_name: created.display_name, is_admin: !!created.is_admin },
              });
            }
          } catch (e2) {
            if (!cancelled) {
              dispatch({
                type: A.SET_AUTH_ERROR,
                error: `Signed in, but profile creation failed: ${e2.message || String(e2)}`,
              });
            }
          }
        } else if (!cancelled) {
          dispatch({
            type: A.SET_AUTH_ERROR,
            error: `Signed in, but couldn't load your profile: ${e.message || String(e)}`,
          });
        }
      }
    }

    // Initial session check (rehydrated from SecureStore).
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const session = data?.session || null;
      dispatch({ type: A.SET_SESSION, session });
      hydrateUserState(session).finally(() => {
        if (!cancelled) dispatch({ type: A.SET_AUTH_READY, value: true });
      });
    });

    // Live updates — sign-in / sign-out / token refresh.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      dispatch({ type: A.SET_SESSION, session });
      hydrateUserState(session);
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  // Bootstrap: initial-load + lazy-load ingredient categories + substitutions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.initialLoad();
        if (cancelled) return;
        dispatch({ type: A.BOOT_LOADED, ...data });
      } catch (e) {
        if (cancelled) return;
        dispatch({ type: A.BOOT_ERROR, error: e.message || String(e) });
      }
      // Non-critical refs in parallel — don't block boot on them.
      api.ingredientCategories().then(
        (data) => !cancelled && dispatch({ type: A.SET_INGREDIENT_CATEGORIES, payload: data || {} }),
        () => {},
      );
      api.substitutions().then(
        (data) => !cancelled && dispatch({ type: A.SET_SUBSTITUTIONS, payload: data || {} }),
        () => {},
      );
      api.cuisines().then(
        (data) => !cancelled && dispatch({ type: A.SET_REF_CUISINES, payload: data || [] }),
        () => {},
      );
      api.units().then(
        (rows) => !cancelled && dispatch({ type: A.SET_REF_UNITS, payload: rows || [] }),
        () => {},
      );
      api.ingredientModifiers().then(
        (rows) => !cancelled && dispatch({ type: A.SET_INGREDIENT_MODIFIERS, payload: rows || [] }),
        () => {}, // 404 means the endpoint isn't live yet; modifier UI degrades gracefully
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate saucebook + pantry whenever the user signs in. Mirrors
  // web/init.js:64-66 — both are background loads kicked off once
  // currentUser lands so the Saucebook / Pantry tabs render instantly
  // when the user navigates to them. CLEAR_AUTH wipes both lists.
  const currentUserId = state.currentUser?.user_id;
  useEffect(() => {
    if (!currentUserId) return;
    api.listSaucebook().then(
      (items) => dispatch({ type: A.SAUCEBOOK_LOADED, items }),
      (e) => dispatch({ type: A.SAUCEBOOK_LOAD_ERROR, error: e.message || String(e) }),
    );
    api.getPantry().then(
      (data) =>
        dispatch({
          type: A.PANTRY_LOADED,
          ingredients: data.ingredients,
          saucebookSauceIds: data.saucebookSauceIds,
        }),
      (e) => dispatch({ type: A.PANTRY_LOAD_ERROR, error: e.message || String(e) }),
    );
    // Re-fetch Browse with the now-authenticated session so each row gets
    // the correct `inSaucebook` flag — and so the `+ Saucebook` button
    // (gated by isSignedIn in BrowseRow) hydrates on rows fetched anonymously
    // before login.
    api.browseSauces({
      q: state.browse?.q || '',
      cuisines: [...(state.browse?.cuisines || [])],
      types: [...(state.browse?.types || [])],
      dishes: [...(state.browse?.dishes || [])],
      author: state.browse?.authorId || null,
      limit: state.browse?.pageSize || 20,
      offset: (state.browse?.page || 0) * (state.browse?.pageSize || 20),
    }).then(
      (data) => dispatch({ type: A.BROWSE_LOADED, items: data.items, total: data.total }),
      () => {}, // best-effort; the screen will refetch on next filter change
    );
  }, [currentUserId]);

  // Stable action creators that wrap async API calls and dispatch reducer events.
  const actions = useMemo(
    () => ({
      retryBoot: async () => {
        try {
          const data = await api.initialLoad();
          dispatch({ type: A.BOOT_LOADED, ...data });
        } catch (e) {
          dispatch({ type: A.BOOT_ERROR, error: e.message || String(e) });
        }
      },

      setMealCategory: (id) => dispatch({ type: A.SET_MEAL_CATEGORY, payload: id }),

      // Selects an item, kicks off the item-load fetch. Returns whether the item
      // has variants (caller decides whether to navigate to PrepSelector or skip).
      selectItem: async (item) => {
        dispatch({ type: A.ITEM_SELECT_START, item });
        try {
          const data = await api.itemLoad(item.id);
          // Backend's `items/{id}/load` returns sauces with ingredients[]; the
          // shared module already attaches ingredientNames Sets in withIngredientNames.
          dispatch({
            type: A.ITEM_LOADED,
            item: data.item,
            variants: data.variants,
            sauces: data.sauces,
            ingredients: data.ingredients,
          });
          return { hasVariants: (data.variants || []).length > 0, error: null };
        } catch (e) {
          dispatch({ type: A.ITEM_LOAD_ERROR, error: e.message || String(e) });
          return { hasVariants: false, error: e.message || String(e) };
        }
      },

      clearItem: () => dispatch({ type: A.CLEAR_ITEM }),
      setPrep: (prep) => dispatch({ type: A.SET_PREP, prep }),
      toggleIngredient: (name) => dispatch({ type: A.TOGGLE_INGREDIENT, name }),
      clearFilter: () => dispatch({ type: A.CLEAR_INGREDIENT_FILTER }),
      setFilterOpen: (open) => dispatch({ type: A.SET_FILTER_OPEN, open }),
      toggleCuisine: (cuisine) => dispatch({ type: A.TOGGLE_CUISINE, cuisine }),

      selectSauce: (sauce, family) => dispatch({ type: A.SELECT_SAUCE, sauce, family }),
      // Browse + Saucebook hold slim rows (no steps / ingredients). Before
      // navigating to Recipe we need the full envelope from /sauces. Mirrors
      // web's browseOpenRecipe (web/browse.js:308).
      openSauceById: async (sauceId) => {
        if (!sauceId) return { ok: false, error: 'no id' };
        try {
          const all = await api.allSauces();
          const target = all.find((s) => s.id === sauceId);
          if (!target) return { ok: false, error: 'Sauce not found' };
          const rootId = target.parentSauceId || target.id;
          const family = all.filter((s) => s.id === rootId || s.parentSauceId === rootId);
          dispatch({ type: A.SELECT_SAUCE, sauce: target, family });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      selectVariant: (sauce) => dispatch({ type: A.SELECT_VARIANT, sauce }),
      setServings: (value) => dispatch({ type: A.SET_SERVINGS, value }),
      setUnitSystem: (value) => dispatch({ type: A.SET_UNIT_SYSTEM, value }),

      togglePieSlice: (stepIndex, name) =>
        dispatch({ type: A.TOGGLE_PIE_SLICE, stepIndex, name }),
      toggleRecipeIngredients: () => dispatch({ type: A.TOGGLE_RECIPE_INGREDIENTS }),
      // Update the local ingredient-categories cache so the builder + recipe
      // views see the new category immediately. Server-side persistence
      // happens later via the admin tools (matches web's classifyIngredientLocal).
      classifyIngredient: (name, category) =>
        dispatch({ type: A.SET_INGREDIENT_CATEGORY, name: name.trim().toLowerCase(), category }),

      toggleEditMode: () => dispatch({ type: A.TOGGLE_EDIT_MODE }),

      // ── Sauce Manager (browse-all) ──────────────────────────────────────────
      loadAllSauces: async () => {
        dispatch({ type: A.MANAGER_LOAD_START });
        try {
          const sauces = await api.allSauces();
          dispatch({ type: A.MANAGER_LOADED, sauces });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.MANAGER_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      setManagerSearch: (value) => dispatch({ type: A.MANAGER_SET_SEARCH, value }),
      setManagerTypeFilter: (value) => dispatch({ type: A.MANAGER_SET_TYPE_FILTER, value }),
      toggleManagerCuisine: (cuisine) => dispatch({ type: A.MANAGER_TOGGLE_CUISINE, cuisine }),
      setManagerTab: (tab) => dispatch({ type: A.MANAGER_SET_TAB, value: tab }),
      // Owner-or-admin delete. Returns { ok, error } and optimistically removes
      // from the manager list on success.
      deleteSauce: async (sauceId) => {
        try {
          await api.deleteSauce(sauceId);
          dispatch({ type: A.MANAGER_REMOVE_SAUCE, sauceId });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },

      // Sauce variant merge — admin only. Long-press a sauce row to start;
      // tap others to mark them as variants; commit assigns
      // parent_sauce_id = keepId on every picked row.
      startSauceMerge: (keepId) => dispatch({ type: A.SAUCE_MERGE_START, keepId }),
      toggleSauceMergePick: (sauceId) => dispatch({ type: A.SAUCE_MERGE_TOGGLE_PICK, sauceId }),
      cancelSauceMerge: () => dispatch({ type: A.SAUCE_MERGE_CANCEL }),
      commitSauceMerge: async () => {
        const merge = stateRef.current.sauceMerge;
        if (!merge || merge.mergeIds.size === 0) {
          return { ok: false, error: 'Pick at least one sauce to merge.' };
        }
        dispatch({ type: A.SAUCE_MERGE_SET_ERROR, error: null, saving: true });
        try {
          await api.assignSauceVariants(merge.keepId, [...merge.mergeIds]);
          await actions.loadAllSauces();
          dispatch({ type: A.SAUCE_MERGE_CANCEL });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.SAUCE_MERGE_SET_ERROR, error: e.message || String(e), saving: false });
          return { ok: false, error: e.message || String(e) };
        }
      },

      // ── Manager → Dish tab ──────────────────────────────────────────────────
      loadAllItems: async () => {
        dispatch({ type: A.ITEMS_LOAD_START });
        try {
          const items = await api.allItems();
          dispatch({ type: A.ITEMS_LOADED, items });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.ITEMS_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      toggleItemSection: (category) => dispatch({ type: A.ITEMS_TOGGLE_SECTION, category }),
      toggleItemParent: (parentId) => dispatch({ type: A.ITEMS_TOGGLE_PARENT, parentId }),
      // Admin CRUD for dishes (carbs / proteins / salads / variants). Each
      // action refreshes the list on success so nested variant data stays in
      // sync without an in-place patch.
      createItem: async (payload) => {
        try {
          await api.createItem(payload);
          await actions._refreshItems();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      updateItem: async (id, payload) => {
        try {
          await api.updateItem(id, payload);
          await actions._refreshItems();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      deleteItem: async (id) => {
        try {
          await api.deleteItem(id);
          await actions._refreshItems();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      _refreshItems: async () => {
        try {
          const items = await api.allItems();
          dispatch({ type: A.ITEMS_LOADED, items });
        } catch {
          // ignore — keep the previous list
        }
      },

      // ── Manager → Ingredients tab ───────────────────────────────────────────
      loadAllIngredients: async () => {
        dispatch({ type: A.INGREDIENTS_LOAD_START });
        try {
          const ingredients = await api.listIngredientsWithUsage();
          dispatch({ type: A.INGREDIENTS_LOADED, ingredients });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.INGREDIENTS_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      toggleIngredientSection: (category) => dispatch({ type: A.INGREDIENTS_TOGGLE_SECTION, category }),
      toggleIngredientExpansion: (ingredientId) => dispatch({ type: A.INGREDIENTS_TOGGLE_EXPAND, ingredientId }),
      // Any logged-in user (not admin-gated). Returns { ok } and refreshes.
      createIngredient: async (payload) => {
        try {
          await api.createIngredient(payload);
          await actions._refreshIngredients();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      updateIngredient: async (id, payload) => {
        try {
          await api.updateIngredient(id, payload);
          await actions._refreshIngredients();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      // Backend returns 409 if the ingredient is in use — caller surfaces the message.
      deleteIngredient: async (id) => {
        try {
          await api.deleteIngredient(id);
          dispatch({ type: A.INGREDIENTS_REMOVE, ingredientId: id });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      _refreshIngredients: async () => {
        try {
          const ingredients = await api.listIngredientsWithUsage();
          dispatch({ type: A.INGREDIENTS_LOADED, ingredients });
        } catch {
          // ignore — keep the previous list
        }
      },

      // ── Manager → Ingredients merge mode ────────────────────────────────────
      startIngredientMerge: (keepId) => dispatch({ type: A.INGREDIENT_MERGE_START, keepId }),
      toggleIngredientMergePick: (ingredientId) => dispatch({ type: A.INGREDIENT_MERGE_TOGGLE_PICK, ingredientId }),
      cancelIngredientMerge: () => dispatch({ type: A.INGREDIENT_MERGE_CANCEL }),
      // Commit: repoints all step ingredients from mergeIds → keepId and
      // deletes the merged ingredient rows. Refreshes on success.
      commitIngredientMerge: async () => {
        const merge = stateRef.current.ingredientMerge;
        if (!merge || merge.mergeIds.size === 0) return { ok: false, error: 'Pick at least one ingredient to merge.' };
        dispatch({ type: A.INGREDIENT_MERGE_SET_ERROR, error: null, saving: true });
        try {
          await api.mergeIngredients(merge.keepId, [...merge.mergeIds]);
          await actions._refreshIngredients();
          dispatch({ type: A.INGREDIENT_MERGE_CANCEL });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.INGREDIENT_MERGE_SET_ERROR, error: e.message || String(e), saving: false });
          return { ok: false, error: e.message || String(e) };
        }
      },

      // ── Auth actions ────────────────────────────────────────────────────────

      // Opens Google's OAuth flow in a system WebBrowser, then exchanges the
      // returned code for a Supabase session. onAuthStateChange in the
      // provider hydrates profile once the session lands.
      signInWithGoogle: async () => {
        if (!isAuthConfigured || !supabase) {
          dispatch({ type: A.SET_AUTH_ERROR, error: 'Sign-in is not configured for this build.' });
          return { ok: false };
        }
        dispatch({ type: A.SET_AUTH_BUSY, value: true });
        dispatch({ type: A.SET_AUTH_ERROR, error: null });
        try {
          const res = await signInWithGoogleOAuth();
          if (res.cancelled) return { ok: false, cancelled: true };
          if (!res.ok) {
            dispatch({ type: A.SET_AUTH_ERROR, error: res.error || 'Could not sign in with Google.' });
            return { ok: false };
          }
          return { ok: true };
        } finally {
          dispatch({ type: A.SET_AUTH_BUSY, value: false });
        }
      },

      signIn: async (email, password) => {
        if (!isAuthConfigured || !supabase) {
          dispatch({ type: A.SET_AUTH_ERROR, error: 'Sign-in is not configured for this build.' });
          return { ok: false };
        }
        dispatch({ type: A.SET_AUTH_BUSY, value: true });
        dispatch({ type: A.SET_AUTH_ERROR, error: null });
        try {
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
          // onAuthStateChange will populate session + currentUser.
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.SET_AUTH_ERROR, error: e.message || String(e) });
          return { ok: false };
        } finally {
          dispatch({ type: A.SET_AUTH_BUSY, value: false });
        }
      },

      signUp: async (email, password) => {
        if (!isAuthConfigured || !supabase) {
          dispatch({ type: A.SET_AUTH_ERROR, error: 'Sign-up is not configured for this build.' });
          return { ok: false };
        }
        dispatch({ type: A.SET_AUTH_BUSY, value: true });
        dispatch({ type: A.SET_AUTH_ERROR, error: null });
        try {
          const { data, error } = await supabase.auth.signUp({ email, password });
          if (error) throw error;
          // Supabase returns a session immediately when "Confirm email" is OFF
          // in the project's Auth provider settings. When ON, session is null
          // and the user has to click the email link before they can sign in.
          const needsConfirmation = !data?.session;
          return { ok: true, needsConfirmation };
        } catch (e) {
          dispatch({ type: A.SET_AUTH_ERROR, error: e.message || String(e) });
          return { ok: false };
        } finally {
          dispatch({ type: A.SET_AUTH_BUSY, value: false });
        }
      },

      signOut: async () => {
        if (!supabase) {
          dispatch({ type: A.CLEAR_AUTH });
          return;
        }
        try {
          await supabase.auth.signOut();
        } catch {
          // ignore — local state will clear on auth state change anyway
        }
        dispatch({ type: A.CLEAR_AUTH });
      },

      clearAuthError: () => dispatch({ type: A.SET_AUTH_ERROR, error: null }),

      becomeAdmin: async (adminKey) => {
        dispatch({ type: A.SET_BECOME_ADMIN_BUSY, value: true });
        dispatch({ type: A.SET_BECOME_ADMIN_ERROR, error: null });
        try {
          const profile = await api.becomeAdmin(adminKey);
          dispatch({
            type: A.SET_CURRENT_USER,
            user: { user_id: profile.id, display_name: profile.display_name, is_admin: !!profile.is_admin },
          });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.SET_BECOME_ADMIN_ERROR, error: e.message || String(e) });
          return { ok: false };
        } finally {
          dispatch({ type: A.SET_BECOME_ADMIN_BUSY, value: false });
        }
      },

      updateDisplayName: async (displayName) => {
        try {
          const profile = await api.upsertProfile(displayName);
          dispatch({
            type: A.SET_CURRENT_USER,
            user: { user_id: profile.id, display_name: profile.display_name, is_admin: !!profile.is_admin },
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },

      deleteAccount: async () => {
        try {
          await api.deleteProfile();
        } catch {
          // even if the server delete fails, signing out locally is still useful
        }
        if (supabase) {
          try { await supabase.auth.signOut(); } catch {}
        }
        dispatch({ type: A.CLEAR_AUTH });
      },

      // ── Three-tab home actions ────────────────────────────────────────
      // Browse — paginated public discovery.
      loadBrowseSauces: async () => {
        const b = stateRef.current.browse;
        dispatch({ type: A.BROWSE_LOAD_START });
        try {
          const data = await api.browseSauces({
            q: b.q,
            cuisines: [...b.cuisines],
            types: [...b.types],
            dishes: [...b.dishes],
            author: b.authorId,
            limit: b.pageSize,
            offset: b.page * b.pageSize,
          });
          dispatch({ type: A.BROWSE_LOADED, items: data.items, total: data.total });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.BROWSE_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      setBrowseSearch: (value) => dispatch({ type: A.BROWSE_SET_SEARCH, value }),
      toggleBrowseCuisine: (cuisine) =>
        dispatch({ type: A.BROWSE_TOGGLE_FILTER, key: 'cuisines', value: cuisine }),
      toggleBrowseType: (type) =>
        dispatch({ type: A.BROWSE_TOGGLE_FILTER, key: 'types', value: type }),
      toggleBrowseDish: (dishId) =>
        dispatch({ type: A.BROWSE_TOGGLE_FILTER, key: 'dishes', value: dishId }),
      setBrowseAuthor: (authorId, authorQuery) =>
        dispatch({ type: A.BROWSE_SET_AUTHOR, authorId, authorQuery }),
      setBrowseAuthorQuery: (value) => dispatch({ type: A.BROWSE_SET_AUTHOR_QUERY, value }),
      setBrowseAuthorResults: (results) =>
        dispatch({ type: A.BROWSE_SET_AUTHOR_RESULTS, results }),
      goBrowsePage: (page) => dispatch({ type: A.BROWSE_SET_PAGE, page }),
      toggleBrowseFilters: () => dispatch({ type: A.BROWSE_TOGGLE_FILTERS_OPEN }),
      clearBrowseFilters: () => dispatch({ type: A.BROWSE_CLEAR_FILTERS }),
      // Fetch author autocomplete (debounced by the caller).
      fetchBrowseAuthors: async (q) => {
        try {
          const results = await api.listAuthors(q);
          dispatch({ type: A.BROWSE_SET_AUTHOR_RESULTS, results });
        } catch {
          dispatch({ type: A.BROWSE_SET_AUTHOR_RESULTS, results: [] });
        }
      },

      // Saucebook — user's library.
      loadSaucebook: async () => {
        if (!stateRef.current.currentUser) return { ok: false };
        dispatch({ type: A.SAUCEBOOK_LOAD_START });
        try {
          const items = await api.listSaucebook();
          dispatch({ type: A.SAUCEBOOK_LOADED, items });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.SAUCEBOOK_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      addToSaucebook: async (sauce) => {
        // Optimistic: mark inSaucebook on the browse row, insert into the
        // saucebook list, then call the API and reconcile on failure.
        if (!sauce?.id) return { ok: false };
        dispatch({ type: A.BROWSE_MARK_IN_SAUCEBOOK, sauceId: sauce.id, value: true });
        // Browse rows are slim — no ingredientNames. Normalize before dispatch
        // so SaucebookRow's missingSauceIngredients() doesn't blow up.
        dispatch({ type: A.SAUCEBOOK_ADD, sauce: withIngredientNames({ ...sauce, inSaucebook: true }) });
        try {
          await api.addToSaucebook(sauce.id);
          // Refresh pantry — the new sauce's ingredients should appear there.
          actions.loadPantry();
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.BROWSE_MARK_IN_SAUCEBOOK, sauceId: sauce.id, value: false });
          dispatch({ type: A.SAUCEBOOK_REMOVE, sauceId: sauce.id });
          return { ok: false, error: e.message || String(e) };
        }
      },
      removeFromSaucebook: async (sauceId) => {
        // Optimistic remove. Browse row's inSaucebook flag flips too if it
        // happens to be currently visible.
        dispatch({ type: A.SAUCEBOOK_REMOVE, sauceId });
        dispatch({ type: A.BROWSE_MARK_IN_SAUCEBOOK, sauceId, value: false });
        try {
          await api.removeFromSaucebook(sauceId);
          actions.loadPantry();
          return { ok: true };
        } catch (e) {
          // Best-effort restore from a fresh fetch — the row is gone locally,
          // refetch puts it back if the server still has it.
          actions.loadSaucebook();
          return { ok: false, error: e.message || String(e) };
        }
      },
      setSaucebookSearch: (value) => dispatch({ type: A.SAUCEBOOK_SET_SEARCH, value }),
      toggleSaucebookCuisine: (cuisine) =>
        dispatch({ type: A.SAUCEBOOK_TOGGLE_FILTER, key: 'cuisines', value: cuisine }),
      toggleSaucebookType: (type) =>
        dispatch({ type: A.SAUCEBOOK_TOGGLE_FILTER, key: 'types', value: type }),
      toggleSaucebookDish: (dishId) =>
        dispatch({ type: A.SAUCEBOOK_TOGGLE_FILTER, key: 'dishes', value: dishId }),
      setSaucebookAuthor: (authorId) =>
        dispatch({ type: A.SAUCEBOOK_SET_AUTHOR, authorId }),
      clearSaucebookFilters: () => dispatch({ type: A.SAUCEBOOK_CLEAR_FILTERS }),
      toggleSaucebookFilters: () => dispatch({ type: A.SAUCEBOOK_TOGGLE_FILTERS_OPEN }),
      toggleCuisineSection: (cuisine) =>
        dispatch({ type: A.SAUCEBOOK_TOGGLE_CUISINE_SECTION, cuisine }),
      setAllSaucebookCuisines: (cuisines, value) =>
        dispatch({ type: A.SAUCEBOOK_SET_ALL_CUISINE_SECTIONS, cuisines, value }),

      // Pantry — negative ingredient list.
      loadPantry: async () => {
        if (!stateRef.current.currentUser) return { ok: false };
        dispatch({ type: A.PANTRY_LOAD_START });
        try {
          const data = await api.getPantry();
          dispatch({
            type: A.PANTRY_LOADED,
            ingredients: data.ingredients,
            saucebookSauceIds: data.saucebookSauceIds,
          });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.PANTRY_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      // Optimistically flip + persist. On failure, refetch to reconcile.
      togglePantryIngredient: async (ingredient) => {
        if (!ingredient?.ingredientId) return { ok: false };
        dispatch({ type: A.PANTRY_TOGGLE_MISSING, ingredientId: ingredient.ingredientId });
        try {
          const missingIds = stateRef.current.pantry.ingredients
            .filter((i) => i.missing)
            .map((i) => i.ingredientId);
          await api.setPantryMissing(missingIds);
          return { ok: true };
        } catch (e) {
          actions.loadPantry();
          return { ok: false, error: e.message || String(e) };
        }
      },
      togglePantrySection: (category) =>
        dispatch({ type: A.PANTRY_TOGGLE_SECTION, category }),
      restockPantry: () => dispatch({ type: A.PANTRY_RESTOCK_ALL }),
      setAllPantrySections: (categories, value) =>
        dispatch({ type: A.PANTRY_SET_ALL_SECTIONS, categories, value }),

    }),
    [],
  );

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

// Re-export wrap helper so other modules don't need to import filter directly.
export { withIngredientNames };
