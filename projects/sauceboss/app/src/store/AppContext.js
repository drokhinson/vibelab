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

  // Reference data
  ingredientCategories: {},
  substitutions: {},

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
  managerFavoritesOnly: false,
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
  managerFoods: [],                   // [{ id, name, plural, usageCount, sauceCount }]
  managerFoodsLoading: false,
  managerFoodsError: null,
  expandedIngredientSections: new Set(), // category names
  expandedFoodIds: new Set(),         // food ids whose sauces panel is open
  foodMerge: null,                    // { keepId, mergeIds: Set, error, saving } when admin is in merge mode

  // Auth (Phase 2 hooks; unused in Phase 1)
  authReady: false,             // false until we've checked supabase for an existing session
  authBusy: false,              // true while a sign-in / sign-up is in flight
  authError: null,
  becomeAdminBusy: false,
  becomeAdminError: null,
  session: null,
  currentUser: null,
  favorites: new Map(),
  favoritesOnly: false,

  // Edit mode — gates editorial UI in the Sauce Manager (Edit / Delete /
  // Download / Merge per-row actions, the `+` FAB, the admin bulk-export
  // button at the bottom of the list). Mirrors the web's `state.editMode`.
  // Defaults to false; flipped by the pencil toggle in the manager header
  // (visible only to logged-in users); reset to false on sign-out.
  editMode: false,
};

// ── Action types ────────────────────────────────────────────────────────────
const A = {
  BOOT_LOADED: 'BOOT_LOADED',
  BOOT_ERROR: 'BOOT_ERROR',
  SET_INGREDIENT_CATEGORIES: 'SET_INGREDIENT_CATEGORIES',
  SET_INGREDIENT_CATEGORY: 'SET_INGREDIENT_CATEGORY',
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

  // Sauce Manager — browse-all view
  MANAGER_LOAD_START: 'MANAGER_LOAD_START',
  MANAGER_LOADED: 'MANAGER_LOADED',
  MANAGER_LOAD_ERROR: 'MANAGER_LOAD_ERROR',
  MANAGER_SET_SEARCH: 'MANAGER_SET_SEARCH',
  MANAGER_SET_TYPE_FILTER: 'MANAGER_SET_TYPE_FILTER',
  MANAGER_SET_FAVORITES_ONLY: 'MANAGER_SET_FAVORITES_ONLY',
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
  FOODS_LOAD_START: 'FOODS_LOAD_START',
  FOODS_LOADED: 'FOODS_LOADED',
  FOODS_LOAD_ERROR: 'FOODS_LOAD_ERROR',
  FOODS_TOGGLE_SECTION: 'FOODS_TOGGLE_SECTION',
  FOODS_TOGGLE_EXPAND: 'FOODS_TOGGLE_EXPAND',
  FOODS_REMOVE: 'FOODS_REMOVE',
  FOOD_MERGE_START: 'FOOD_MERGE_START',
  FOOD_MERGE_TOGGLE_PICK: 'FOOD_MERGE_TOGGLE_PICK',
  FOOD_MERGE_CANCEL: 'FOOD_MERGE_CANCEL',
  FOOD_MERGE_SET_ERROR: 'FOOD_MERGE_SET_ERROR',

  // Phase 2 hooks (auth + favorites). Not used in Phase 1 but reducer handles them so wiring later is trivial.
  SET_AUTH_READY: 'SET_AUTH_READY',
  SET_AUTH_BUSY: 'SET_AUTH_BUSY',
  SET_AUTH_ERROR: 'SET_AUTH_ERROR',
  SET_SESSION: 'SET_SESSION',
  SET_CURRENT_USER: 'SET_CURRENT_USER',
  SET_FAVORITES: 'SET_FAVORITES',
  SET_FAVORITE: 'SET_FAVORITE',
  SET_FAVORITES_ONLY: 'SET_FAVORITES_ONLY',
  SET_BECOME_ADMIN_BUSY: 'SET_BECOME_ADMIN_BUSY',
  SET_BECOME_ADMIN_ERROR: 'SET_BECOME_ADMIN_ERROR',
  CLEAR_AUTH: 'CLEAR_AUTH',

  TOGGLE_EDIT_MODE: 'TOGGLE_EDIT_MODE',
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

    case A.SET_INGREDIENT_CATEGORY: {
      const next = { ...(state.ingredientCategories || {}) };
      next[action.name] = action.category;
      return { ...state, ingredientCategories: next };
    }

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

    case A.MANAGER_SET_FAVORITES_ONLY:
      return { ...state, managerFavoritesOnly: !!action.value };

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

    case A.FOODS_LOAD_START:
      return { ...state, managerFoodsLoading: true, managerFoodsError: null };

    case A.FOODS_LOADED:
      return {
        ...state,
        managerFoods: action.foods || [],
        managerFoodsLoading: false,
        managerFoodsError: null,
      };

    case A.FOODS_LOAD_ERROR:
      return { ...state, managerFoodsLoading: false, managerFoodsError: action.error };

    case A.FOODS_TOGGLE_SECTION: {
      const next = new Set(state.expandedIngredientSections);
      if (next.has(action.category)) next.delete(action.category);
      else next.add(action.category);
      return { ...state, expandedIngredientSections: next };
    }

    case A.FOODS_TOGGLE_EXPAND: {
      const next = new Set(state.expandedFoodIds);
      if (next.has(action.foodId)) next.delete(action.foodId);
      else next.add(action.foodId);
      return { ...state, expandedFoodIds: next };
    }

    case A.FOODS_REMOVE:
      return { ...state, managerFoods: state.managerFoods.filter((f) => f.id !== action.foodId) };

    case A.FOOD_MERGE_START:
      return {
        ...state,
        foodMerge: { keepId: action.keepId, mergeIds: new Set(), error: null, saving: false },
      };

    case A.FOOD_MERGE_TOGGLE_PICK: {
      if (!state.foodMerge) return state;
      const next = new Set(state.foodMerge.mergeIds);
      if (next.has(action.foodId)) next.delete(action.foodId);
      else next.add(action.foodId);
      return { ...state, foodMerge: { ...state.foodMerge, mergeIds: next, error: null } };
    }

    case A.FOOD_MERGE_CANCEL:
      return { ...state, foodMerge: null };

    case A.FOOD_MERGE_SET_ERROR:
      return state.foodMerge
        ? { ...state, foodMerge: { ...state.foodMerge, error: action.error, saving: !!action.saving } }
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

    case A.SET_BECOME_ADMIN_BUSY:
      return { ...state, becomeAdminBusy: !!action.value };

    case A.SET_BECOME_ADMIN_ERROR:
      return { ...state, becomeAdminError: action.error || null };

    case A.CLEAR_AUTH:
      return {
        ...state,
        session: null,
        currentUser: null,
        favorites: new Map(),
        favoritesOnly: false,
        authError: null,
        becomeAdminError: null,
        editMode: false,
      };

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
  // profile (auto-create on 404) + favorites. On sign-out, clear them.
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
      // Profile: 404 means auto-create.
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
          } catch {
            // ignore — non-fatal, user is signed in but profile creation failed
          }
        }
      }

      // Favorites — non-blocking.
      try {
        const favs = await api.listFavorites();
        if (!cancelled) dispatch({ type: A.SET_FAVORITES, favorites: favs });
      } catch {
        // ignore
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
      setManagerFavoritesOnly: (value) => dispatch({ type: A.MANAGER_SET_FAVORITES_ONLY, value }),
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
      loadAllFoods: async () => {
        dispatch({ type: A.FOODS_LOAD_START });
        try {
          const foods = await api.listFoodsWithUsage();
          dispatch({ type: A.FOODS_LOADED, foods });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.FOODS_LOAD_ERROR, error: e.message || String(e) });
          return { ok: false, error: e.message || String(e) };
        }
      },
      toggleIngredientSection: (category) => dispatch({ type: A.FOODS_TOGGLE_SECTION, category }),
      toggleFoodExpansion: (foodId) => dispatch({ type: A.FOODS_TOGGLE_EXPAND, foodId }),
      // Any logged-in user (not admin-gated). Returns { ok } and refreshes.
      createFood: async (payload) => {
        try {
          await api.createFood(payload);
          await actions._refreshFoods();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      // Upserts an ingredient → category mapping. Updates local state
      // immediately and fires the API call in the background; failures get
      // returned to the caller (FoodFormModal surfaces them as the form error).
      classifyIngredient: async (name, category) => {
        const trimmed = (name || '').trim();
        const cat = (category || '').trim();
        if (!trimmed || !cat) return { ok: false, error: 'Name and category are required.' };
        dispatch({ type: A.SET_INGREDIENT_CATEGORY, name: trimmed.toLowerCase(), category: cat });
        try {
          await api.classifyIngredient(trimmed, cat);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      updateFood: async (id, payload) => {
        try {
          await api.updateFood(id, payload);
          await actions._refreshFoods();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      // Backend returns 409 if the food is in use — caller surfaces the message.
      deleteFood: async (id) => {
        try {
          await api.deleteFood(id);
          dispatch({ type: A.FOODS_REMOVE, foodId: id });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      _refreshFoods: async () => {
        try {
          const foods = await api.listFoodsWithUsage();
          dispatch({ type: A.FOODS_LOADED, foods });
        } catch {
          // ignore — keep the previous list
        }
      },

      // ── Manager → Ingredients merge mode ────────────────────────────────────
      startFoodMerge: (keepId) => dispatch({ type: A.FOOD_MERGE_START, keepId }),
      toggleFoodMergePick: (foodId) => dispatch({ type: A.FOOD_MERGE_TOGGLE_PICK, foodId }),
      cancelFoodMerge: () => dispatch({ type: A.FOOD_MERGE_CANCEL }),
      // Commit: repoints all step ingredients from mergeIds → keepId and
      // deletes the merged food rows. Refreshes on success.
      commitFoodMerge: async () => {
        const merge = stateRef.current.foodMerge;
        if (!merge || merge.mergeIds.size === 0) return { ok: false, error: 'Pick at least one ingredient to merge.' };
        dispatch({ type: A.FOOD_MERGE_SET_ERROR, error: null, saving: true });
        try {
          await api.mergeFoods(merge.keepId, [...merge.mergeIds]);
          await actions._refreshFoods();
          dispatch({ type: A.FOOD_MERGE_CANCEL });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.FOOD_MERGE_SET_ERROR, error: e.message || String(e), saving: false });
          return { ok: false, error: e.message || String(e) };
        }
      },

      // ── Auth actions ────────────────────────────────────────────────────────

      // Opens Google's OAuth flow in a system WebBrowser, then exchanges the
      // returned code for a Supabase session. onAuthStateChange in the
      // provider hydrates profile + favorites once the session lands.
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
          // onAuthStateChange will populate session + currentUser + favorites.
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

      // ── Favorites ───────────────────────────────────────────────────────────
      // Optimistic toggle. Updates UI immediately, syncs in the background,
      // reverts on failure. If the user isn't signed in, returns false so
      // the caller can prompt sign-in.
      toggleFavorite: async (sauceId) => {
        const cur = stateRef.current;
        if (!cur.currentUser) return { ok: false, reason: 'unauthenticated' };
        const wasFavorited = cur.favorites.has(sauceId);
        const previousTimestamp = cur.favorites.get(sauceId);
        dispatch({ type: A.SET_FAVORITE, sauceId, favorited: !wasFavorited });
        try {
          if (wasFavorited) await api.removeFavorite(sauceId);
          else await api.addFavorite(sauceId);
          return { ok: true };
        } catch (e) {
          // revert
          dispatch({ type: A.SET_FAVORITE, sauceId, favorited: wasFavorited, timestamp: previousTimestamp });
          return { ok: false, error: e.message || String(e) };
        }
      },

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
