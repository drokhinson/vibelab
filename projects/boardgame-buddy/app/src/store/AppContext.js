// Central app state — mirrors web/domain/store.js shape. Reducer + provider.
// Read state, dispatch, and actions are split into three contexts so screens
// that only dispatch/act don't re-render on read changes.

import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, setAuthTokenGetter } from '../api/client';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { signInWithGoogleOAuth } from '../auth/oauth';

// ── Initial state ───────────────────────────────────────────────────────────
export const initialState = {
  // Auth / boot
  authReady: false, // false until Supabase getSession() resolves
  authBusy: false,
  authError: null,
  session: null,
  currentUser: null, // { id, display_name, username, avatar, is_admin }
  becomeAdminBusy: false,
  becomeAdminError: null,

  // Bootstrap-seeded first paint
  bootstrapped: false,
  feed: null, // FeedPageResponse
  feedCursor: null,
  feedLoading: false,
  myCollectionMap: {}, // gameId -> 'owned' | 'wishlist' | 'played'
  expansionCounts: {}, // base_game_bgg_id -> owned expansion count
  stats: null,
  profileBundle: null,
  gameBundles: {}, // gameId -> detail bundle (cache)
  recentlyPlayedGames: [], // host game-picker seed
  playPartners: { accounts: [], ghosts: [], recent: [] }, // host player-picker seed

  // Lookups
  chapterTypes: [],

  // Live session draft (host flow). Persisted to AsyncStorage by playSession model.
  activeSession: null,
};

// ── Action types ──────────────────────────────────────────────────────────
const A = {
  SET_AUTH_READY: 'SET_AUTH_READY',
  SET_SESSION: 'SET_SESSION',
  SET_CURRENT_USER: 'SET_CURRENT_USER',
  SET_AUTH_BUSY: 'SET_AUTH_BUSY',
  SET_AUTH_ERROR: 'SET_AUTH_ERROR',
  CLEAR_AUTH: 'CLEAR_AUTH',
  SET_BECOME_ADMIN: 'SET_BECOME_ADMIN',

  BOOTSTRAP_LOADED: 'BOOTSTRAP_LOADED',
  SET_FEED: 'SET_FEED',
  APPEND_FEED: 'APPEND_FEED',
  SET_FEED_LOADING: 'SET_FEED_LOADING',
  SET_COLLECTION_STATUS: 'SET_COLLECTION_STATUS',
  SET_COLLECTION_MAP: 'SET_COLLECTION_MAP',
  SET_STATS: 'SET_STATS',
  CACHE_GAME_BUNDLE: 'CACHE_GAME_BUNDLE',
  SET_CHAPTER_TYPES: 'SET_CHAPTER_TYPES',
  SET_HOST_SEEDS: 'SET_HOST_SEEDS',
  SET_ACTIVE_SESSION: 'SET_ACTIVE_SESSION',
};

function reducer(state, action) {
  switch (action.type) {
    case A.SET_AUTH_READY:
      return { ...state, authReady: action.value };
    case A.SET_SESSION:
      return { ...state, session: action.session };
    case A.SET_CURRENT_USER:
      return { ...state, currentUser: action.user, authError: null };
    case A.SET_AUTH_BUSY:
      return { ...state, authBusy: action.value };
    case A.SET_AUTH_ERROR:
      return { ...state, authError: action.error, authBusy: false };
    case A.CLEAR_AUTH:
      return {
        ...state,
        session: null,
        currentUser: null,
        feed: null,
        feedCursor: null,
        myCollectionMap: {},
        expansionCounts: {},
        stats: null,
        profileBundle: null,
        gameBundles: {},
        recentlyPlayedGames: [],
        playPartners: { accounts: [], ghosts: [], recent: [] },
        bootstrapped: false,
        activeSession: null,
      };
    case A.SET_BECOME_ADMIN:
      return { ...state, becomeAdminBusy: !!action.busy, becomeAdminError: action.error || null };

    case A.BOOTSTRAP_LOADED: {
      const p = action.payload || {};
      const pb = p.profile_bundle || {};
      return {
        ...state,
        bootstrapped: true,
        feed: p.feed_first_page || state.feed,
        feedCursor: p.feed_cursor || null,
        myCollectionMap: pb.status_map || state.myCollectionMap,
        expansionCounts: pb.expansion_counts || state.expansionCounts,
        stats: pb.stats || state.stats,
        profileBundle: p.profile_bundle || state.profileBundle,
        gameBundles: { ...state.gameBundles, ...(p.game_detail_bundles || {}) },
        recentlyPlayedGames: p.recently_played_games || [],
        playPartners: p.play_partners || state.playPartners,
        currentUser: p.current_user
          ? {
              id: p.current_user.id,
              display_name: p.current_user.display_name,
              username: p.current_user.username,
              avatar: p.current_user.avatar || null,
              is_admin: !!p.current_user.is_admin,
            }
          : state.currentUser,
      };
    }
    case A.SET_FEED:
      return { ...state, feed: action.feed, feedCursor: action.cursor ?? null, feedLoading: false };
    case A.APPEND_FEED: {
      const prev = state.feed && Array.isArray(state.feed.cards) ? state.feed.cards : [];
      const next = action.feed && Array.isArray(action.feed.cards) ? action.feed.cards : [];
      return {
        ...state,
        feed: { ...(state.feed || {}), cards: [...prev, ...next] },
        feedCursor: action.cursor ?? null,
        feedLoading: false,
      };
    }
    case A.SET_FEED_LOADING:
      return { ...state, feedLoading: action.value };
    case A.SET_COLLECTION_STATUS: {
      const next = { ...state.myCollectionMap };
      if (action.status) next[action.gameId] = action.status;
      else delete next[action.gameId];
      return { ...state, myCollectionMap: next };
    }
    case A.SET_COLLECTION_MAP:
      return { ...state, myCollectionMap: action.map || {} };
    case A.SET_STATS:
      return { ...state, stats: action.stats };
    case A.CACHE_GAME_BUNDLE:
      return { ...state, gameBundles: { ...state.gameBundles, [action.gameId]: action.bundle } };
    case A.SET_CHAPTER_TYPES:
      return { ...state, chapterTypes: action.types || [] };
    case A.SET_HOST_SEEDS:
      return {
        ...state,
        recentlyPlayedGames: action.games ?? state.recentlyPlayedGames,
        playPartners: action.partners ?? state.playPartners,
      };
    case A.SET_ACTIVE_SESSION:
      return { ...state, activeSession: action.session };
    default:
      return state;
  }
}

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

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Wire the API client to read the token directly from Supabase (not React
  // state) — going through state races the SET_SESSION dispatch.
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

  // Auth bootstrap: subscribe to Supabase session changes. On sign-in fetch
  // profile (auto-create on 404). On sign-out clear everything.
  useEffect(() => {
    if (!isAuthConfigured || !supabase) {
      dispatch({ type: A.SET_AUTH_READY, value: true });
      return undefined;
    }
    let cancelled = false;

    async function hydrate(session) {
      if (!session) {
        dispatch({ type: A.CLEAR_AUTH });
        return;
      }
      try {
        const profile = await api.getProfile();
        if (cancelled) return;
        dispatch({ type: A.SET_CURRENT_USER, user: normUser(profile) });
      } catch (e) {
        if (e.status === 404) {
          try {
            const created = await api.upsertProfile(
              session.user?.email?.split('@')[0] || 'Player',
            );
            if (!cancelled) dispatch({ type: A.SET_CURRENT_USER, user: normUser(created) });
          } catch (e2) {
            if (!cancelled) {
              dispatch({ type: A.SET_AUTH_ERROR, error: `Profile creation failed: ${e2.message}` });
            }
          }
        } else if (!cancelled) {
          dispatch({ type: A.SET_AUTH_ERROR, error: `Couldn't load your profile: ${e.message}` });
        }
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const session = data?.session || null;
      dispatch({ type: A.SET_SESSION, session });
      hydrate(session).finally(() => {
        if (!cancelled) dispatch({ type: A.SET_AUTH_READY, value: true });
      });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      dispatch({ type: A.SET_SESSION, session });
      hydrate(session);
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  // Bootstrap seed: once currentUser lands, one GET /bootstrap warms first
  // paint. Falls back to lazy per-screen fetches if it fails.
  const currentUserId = state.currentUser?.id;
  useEffect(() => {
    if (!currentUserId || state.bootstrapped) return undefined;
    let cancelled = false;
    api.bootstrap().then(
      (payload) => !cancelled && dispatch({ type: A.BOOTSTRAP_LOADED, payload }),
      () => {
        // Fallback: pull the essentials individually.
        api.feed().then((f) => !cancelled && dispatch({ type: A.SET_FEED, feed: f, cursor: f?.next_cursor }), () => {});
        api.myStats().then((s) => !cancelled && dispatch({ type: A.SET_STATS, stats: s }), () => {});
        api.collection().then((items) => {
          if (cancelled) return;
          const map = {};
          (Array.isArray(items) ? items : items?.items || []).forEach((it) => {
            if (it.status) map[it.game_id] = it.status;
          });
          dispatch({ type: A.SET_COLLECTION_MAP, map });
        }, () => {});
      },
    );
    // Chapter types (lookup) — cheap, load once.
    api.chapterTypes().then((t) => !cancelled && dispatch({ type: A.SET_CHAPTER_TYPES, types: t }), () => {});
    return () => { cancelled = true; };
  }, [currentUserId, state.bootstrapped]);

  // Actions — screens never call fetch directly for auth/feed/collection.
  const actions = useMemo(
    () => ({
      async signInEmail(email, password) {
        if (!supabase) return { ok: false, error: 'Sign-in is not configured.' };
        dispatch({ type: A.SET_AUTH_BUSY, value: true });
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        dispatch({ type: A.SET_AUTH_BUSY, value: false });
        if (error) {
          dispatch({ type: A.SET_AUTH_ERROR, error: error.message });
          return { ok: false, error: error.message };
        }
        return { ok: true };
      },
      async signUpEmail(email, password) {
        if (!supabase) return { ok: false, error: 'Sign-in is not configured.' };
        dispatch({ type: A.SET_AUTH_BUSY, value: true });
        const { data, error } = await supabase.auth.signUp({ email, password });
        dispatch({ type: A.SET_AUTH_BUSY, value: false });
        if (error) {
          dispatch({ type: A.SET_AUTH_ERROR, error: error.message });
          return { ok: false, error: error.message };
        }
        // If email confirmation is OFF, signUp returns a session → auto signed in.
        return { ok: true, needsConfirm: !data?.session };
      },
      async signInGoogle() {
        dispatch({ type: A.SET_AUTH_BUSY, value: true });
        const r = await signInWithGoogleOAuth();
        dispatch({ type: A.SET_AUTH_BUSY, value: false });
        if (!r.ok && !r.cancelled) dispatch({ type: A.SET_AUTH_ERROR, error: r.error });
        return r;
      },
      async signOut() {
        if (supabase) await supabase.auth.signOut();
        dispatch({ type: A.CLEAR_AUTH });
      },
      async becomeAdmin(key) {
        dispatch({ type: A.SET_BECOME_ADMIN, busy: true });
        try {
          const u = await api.becomeAdmin(key);
          dispatch({ type: A.SET_CURRENT_USER, user: normUser(u) });
          dispatch({ type: A.SET_BECOME_ADMIN, busy: false });
          return { ok: true };
        } catch (e) {
          dispatch({ type: A.SET_BECOME_ADMIN, busy: false, error: e.message });
          return { ok: false, error: e.message };
        }
      },
      async refreshFeed() {
        dispatch({ type: A.SET_FEED_LOADING, value: true });
        try {
          const f = await api.feed();
          dispatch({ type: A.SET_FEED, feed: f, cursor: f?.next_cursor });
        } catch {
          dispatch({ type: A.SET_FEED_LOADING, value: false });
        }
      },
      async loadMoreFeed(cursor) {
        if (!cursor) return;
        dispatch({ type: A.SET_FEED_LOADING, value: true });
        try {
          const f = await api.feed({ cursor });
          dispatch({ type: A.APPEND_FEED, feed: f, cursor: f?.next_cursor });
        } catch {
          dispatch({ type: A.SET_FEED_LOADING, value: false });
        }
      },
      // Collection status — the one place tiles flip shelf state, app-wide.
      async setCollectionStatus(gameId, status) {
        const prev = state.myCollectionMap[gameId] || null;
        dispatch({ type: A.SET_COLLECTION_STATUS, gameId, status });
        try {
          if (!status) await api.removeFromCollection(gameId);
          else if (prev) await api.updateCollection(gameId, status);
          else await api.addToCollection(gameId, status);
        } catch (e) {
          // Roll back on failure.
          dispatch({ type: A.SET_COLLECTION_STATUS, gameId, status: prev });
          throw e;
        }
      },
      async loadGameBundle(gameId, { force = false } = {}) {
        if (!force && state.gameBundles[gameId]) return state.gameBundles[gameId];
        const bundle = await api.gameBundle(gameId);
        dispatch({ type: A.CACHE_GAME_BUNDLE, gameId, bundle });
        return bundle;
      },
      async refreshHostSeeds() {
        try {
          const [games, accounts, ghosts, recent] = await Promise.all([
            api.recentlyPlayedGames().catch(() => []),
            api.buddies().catch(() => []),
            api.ghostPlayers().catch(() => []),
            api.playedWith().catch(() => []),
          ]);
          dispatch({
            type: A.SET_HOST_SEEDS,
            games,
            partners: { accounts: accounts || [], ghosts: ghosts || [], recent: recent || [] },
          });
        } catch {}
      },
      setActiveSession(session) {
        dispatch({ type: A.SET_ACTIVE_SESSION, session });
      },
      dispatch,
    }),
    [state.myCollectionMap, state.gameBundles],
  );

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

function normUser(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    display_name: raw.display_name,
    username: raw.username,
    avatar: raw.avatar || null,
    is_admin: !!raw.is_admin,
  };
}

export { A as ACTIONS };
