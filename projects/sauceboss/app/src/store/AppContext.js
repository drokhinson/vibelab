// Central app state — mirrors web/state.js shape. Reducer + provider.
// Read context and dispatch are split so screens that only dispatch don't
// re-render on read changes.

import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, setAuthTokenGetter } from '../api/client';
import { supabase, isAuthConfigured } from '../auth/supabase';
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
  authReady: false,             // false until we've checked supabase for an existing session
  authBusy: false,              // true while a sign-in / sign-up is in flight
  authError: null,
  becomeAdminBusy: false,
  becomeAdminError: null,
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

    case A.SET_AUTH_READY:
      return { ...state, authReady: !!action.value };

    case A.SET_AUTH_BUSY:
      return { ...state, authBusy: !!action.value };

    case A.SET_AUTH_ERROR:
      return { ...state, authError: action.error || null };

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

  // Wire the API client to read the auth token from this context.
  useEffect(() => {
    setAuthTokenGetter(() => stateRef.current.session?.access_token || null);
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

      // ── Auth actions ────────────────────────────────────────────────────────
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
          const { error } = await supabase.auth.signUp({ email, password });
          if (error) throw error;
          return { ok: true };
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
