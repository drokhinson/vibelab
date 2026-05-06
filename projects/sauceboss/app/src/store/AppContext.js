// Central app state — mirrors web/state.js shape. Reducer + provider.
// Read context and dispatch are split so screens that only dispatch don't
// re-render on read changes.

import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, setAuthTokenGetter } from '../api/client';
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

  // Reference data
  ingredientCategories: {},
  substitutions: {},

  // Filter state
  disabledIngredients: new Set(),
  filterOpen: false,
  expandedCuisines: new Set(),

  // Final meal (set when sauce is picked)
  meal: { item: null, prep: null, sauce: null },

  // Auth (Phase 2 hooks; unused in Phase 1)
  session: null,
  currentUser: null,
  favorites: new Map(),
  favoritesOnly: false,
};

// ── Action types ────────────────────────────────────────────────────────────
const A = {
  BOOT_LOADED: 'BOOT_LOADED',
  BOOT_ERROR: 'BOOT_ERROR',
  SET_INGREDIENT_CATEGORIES: 'SET_INGREDIENT_CATEGORIES',
  SET_SUBSTITUTIONS: 'SET_SUBSTITUTIONS',
  SET_MEAL_CATEGORY: 'SET_MEAL_CATEGORY',

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

  // Phase 2 hooks (auth + favorites). Not used in Phase 1 but reducer handles them so wiring later is trivial.
  SET_SESSION: 'SET_SESSION',
  SET_CURRENT_USER: 'SET_CURRENT_USER',
  SET_FAVORITES: 'SET_FAVORITES',
  SET_FAVORITE: 'SET_FAVORITE',
  SET_FAVORITES_ONLY: 'SET_FAVORITES_ONLY',
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

    case A.SET_INGREDIENT_CATEGORIES:
      return { ...state, ingredientCategories: action.payload || {} };

    case A.SET_SUBSTITUTIONS:
      return { ...state, substitutions: action.payload || {} };

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
        meal: { ...state.meal, sauce },
      };
    }

    case A.SET_SERVINGS:
      return { ...state, servings: Math.max(1, Math.min(12, action.value)) };

    case A.SET_UNIT_SYSTEM:
      return { ...state, unitSystem: action.value === 'metric' ? 'metric' : 'imperial' };

    case A.SET_SESSION:
      return { ...state, session: action.session };

    case A.SET_CURRENT_USER:
      return { ...state, currentUser: action.user };

    case A.SET_FAVORITES:
      return { ...state, favorites: action.favorites || new Map() };

    case A.SET_FAVORITE: {
      const next = new Map(state.favorites);
      if (action.favorited) next.set(action.sauceId, action.timestamp || new Date().toISOString());
      else next.delete(action.sauceId);
      return { ...state, favorites: next };
    }

    case A.SET_FAVORITES_ONLY:
      return { ...state, favoritesOnly: !!action.value };

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

  // Wire the API client to read the auth token from this context.
  useEffect(() => {
    setAuthTokenGetter(() => stateRef.current.session?.access_token || null);
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
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      selectVariant: (sauce) => dispatch({ type: A.SELECT_VARIANT, sauce }),
      setServings: (value) => dispatch({ type: A.SET_SERVINGS, value }),
      setUnitSystem: (value) => dispatch({ type: A.SET_UNIT_SYSTEM, value }),

      // Phase 2 hooks (no-ops in Phase 1 — auth UI not wired yet)
      setSession: (session) => dispatch({ type: A.SET_SESSION, session }),
      setCurrentUser: (user) => dispatch({ type: A.SET_CURRENT_USER, user }),
      setFavorites: (favorites) => dispatch({ type: A.SET_FAVORITES, favorites }),
      setFavorite: (sauceId, favorited, timestamp) =>
        dispatch({ type: A.SET_FAVORITE, sauceId, favorited, timestamp }),
      setFavoritesOnly: (value) => dispatch({ type: A.SET_FAVORITES_ONLY, value }),
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
