// src/store/AppContext.js — global app state via Context + useReducer.
//
// Split read/write contexts: components read from useAppState() and call actions
// from useAppActions(). Owns auth lifecycle + the app-wide collection status map
// (single source of truth for StatusTag, mirroring the web status-changed event).
//
// Auth lifecycle (ported from web init.js + bootstrap.js):
//   - Subscribe to supabase.auth.onAuthStateChange.
//   - On a real session, bind the per-user cache, then hydrate via GET /bootstrap
//     (seeds every cache namespace); fall back to GET /profile on failure.
//   - A transient network blip keeps the session and retries; only an explicit
//     SIGNED_OUT or a 401/403 on load clears state.

import React, {
  createContext, useContext, useEffect, useMemo, useReducer, useRef,
} from 'react';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { signInWithGoogleOAuth } from '../auth/oauth';
import { api } from '../api/client';
import { bgbCache } from '../cache';
import { loadBootstrap } from '../cache/bootstrap';
import { Collection } from '../domain/collection';
import { Feed } from '../domain/feed';

export const initialState = {
  authReady: false,
  authBusy: false,
  authError: null,
  session: null,
  currentUser: null,
  needsOnboarding: false,

  collectionMap: {}, // gameId -> 'owned'|'wishlist'|'played'
  feed: null,
  feedCursor: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_AUTH_READY': return { ...state, authReady: true };
    case 'SET_AUTH_BUSY':
      return { ...state, authBusy: action.value, authError: action.value ? null : state.authError };
    case 'SET_AUTH_ERROR': return { ...state, authError: action.error, authBusy: false };
    case 'SET_SESSION': return { ...state, session: action.session };
    case 'SET_USER':
      return { ...state, currentUser: action.user, needsOnboarding: action.needsOnboarding ?? false };
    case 'SET_COLLECTION_MAP': return { ...state, collectionMap: action.map || {} };
    case 'PATCH_COLLECTION_STATUS': {
      const next = { ...state.collectionMap };
      if (action.status == null) delete next[action.gameId];
      else next[action.gameId] = action.status;
      return { ...state, collectionMap: next };
    }
    case 'SET_FEED': return { ...state, feed: action.feed, feedCursor: action.cursor ?? state.feedCursor };
    case 'SIGN_OUT': return { ...initialState, authReady: true };
    case 'SET': return { ...state, [action.key]: action.value };
    default: return state;
  }
}

const StateContext = createContext(initialState);
const ActionsContext = createContext({});

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const sessionRef = useRef(null);

  async function loadProfileFallback() {
    try {
      const profile = await api.get('/profile');
      const hasName = !!(profile && profile.display_name);
      dispatch({ type: 'SET_USER', user: profile || null, needsOnboarding: !hasName });
      // Prime the collection map separately since bootstrap didn't run.
      Collection.myStatusMap().then((m) => dispatch({ type: 'SET_COLLECTION_MAP', map: m || {} })).catch(() => {});
      return 'ok';
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) return 'failed';
      if (e && e.status === 404) {
        dispatch({ type: 'SET_USER', user: null, needsOnboarding: true });
        return 'ok';
      }
      return 'deferred';
    }
  }

  async function hydrateViaBootstrap() {
    try {
      const payload = await loadBootstrap();
      const me = payload.current_user;
      const hasName = !!(me && me.display_name);
      dispatch({ type: 'SET_USER', user: me || null, needsOnboarding: !hasName });
      const sm = (payload.profile_bundle && payload.profile_bundle.status_map) || {};
      dispatch({ type: 'SET_COLLECTION_MAP', map: sm });
      if (payload.feed_first_page) {
        dispatch({ type: 'SET_FEED', feed: payload.feed_first_page, cursor: payload.feed_cursor || null });
      }
      return 'ok';
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) return 'failed';
      return 'deferred';
    }
  }

  async function applySession(session) {
    sessionRef.current = session;
    dispatch({ type: 'SET_SESSION', session });
    if (!session) {
      await bgbCache.unbindUser();
      dispatch({ type: 'SET_USER', user: null, needsOnboarding: false });
      dispatch({ type: 'SET_COLLECTION_MAP', map: {} });
      return;
    }
    const uid = session.user && session.user.id;
    if (uid) await bgbCache.bindUser(uid);

    // Bootstrap first (seeds caches); fall back to /profile on transient failure.
    let outcome = await hydrateViaBootstrap();
    if (outcome === 'deferred') outcome = await loadProfileFallback();
    if (outcome === 'deferred') {
      await new Promise((r) => setTimeout(r, 800));
      outcome = await loadProfileFallback();
    }
    if (outcome === 'failed') {
      try { await supabase.auth.signOut(); } catch {}
      await bgbCache.unbindUser();
      dispatch({ type: 'SIGN_OUT' });
    }
  }

  useEffect(() => {
    if (!isAuthConfigured || !supabase) {
      dispatch({ type: 'SET_AUTH_READY' });
      return undefined;
    }
    let active = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        await applySession(data ? data.session : null);
      } catch {}
      finally { if (active) dispatch({ type: 'SET_AUTH_READY' }); }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'SIGNED_OUT') {
        sessionRef.current = null;
        bgbCache.unbindUser().catch(() => {});
        dispatch({ type: 'SIGN_OUT' });
        return;
      }
      const prevUser = sessionRef.current && sessionRef.current.user && sessionRef.current.user.id;
      const nextUser = session && session.user && session.user.id;
      if (event === 'TOKEN_REFRESHED' && prevUser && prevUser === nextUser) {
        sessionRef.current = session;
        dispatch({ type: 'SET_SESSION', session });
        return;
      }
      applySession(session || null);
    });

    return () => {
      active = false;
      try { sub.subscription.unsubscribe(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = useMemo(() => ({
    async signInEmail(email, password) {
      if (!supabase) return { ok: false, error: 'Sign-in is not configured.' };
      dispatch({ type: 'SET_AUTH_BUSY', value: true });
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        dispatch({ type: 'SET_AUTH_ERROR', error: error.message });
        return { ok: false, error: error.message };
      }
      dispatch({ type: 'SET_AUTH_BUSY', value: false });
      return { ok: true };
    },

    async signUpEmail(email, password) {
      if (!supabase) return { ok: false, error: 'Sign-up is not configured.' };
      dispatch({ type: 'SET_AUTH_BUSY', value: true });
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) {
        dispatch({ type: 'SET_AUTH_ERROR', error: error.message });
        return { ok: false, error: error.message };
      }
      dispatch({ type: 'SET_AUTH_BUSY', value: false });
      return { ok: true, needsConfirm: !(data && data.session) };
    },

    async signInGoogle() {
      dispatch({ type: 'SET_AUTH_BUSY', value: true });
      const res = await signInWithGoogleOAuth();
      if (!res.ok && !res.cancelled) {
        dispatch({ type: 'SET_AUTH_ERROR', error: res.error || 'Google sign-in failed.' });
      } else {
        dispatch({ type: 'SET_AUTH_BUSY', value: false });
      }
      return res;
    },

    async signOut() {
      try { await supabase?.auth.signOut(); } catch {}
      await bgbCache.unbindUser();
      dispatch({ type: 'SIGN_OUT' });
    },

    async refreshProfile() { return loadProfileFallback(); },

    async refreshCollection() {
      try {
        const map = await Collection.myStatusMap();
        dispatch({ type: 'SET_COLLECTION_MAP', map: map || {} });
      } catch {}
    },

    // Warm-refresh the live blocks (feed first page + collection) on app focus.
    async warmRefresh() {
      try { await Feed.refreshFirstPage(); } catch {}
      try {
        const map = await Collection.myStatusMap({ force: true });
        dispatch({ type: 'SET_COLLECTION_MAP', map: map || {} });
      } catch {}
    },

    async setCollectionStatus(gameId, status) {
      // Optimistic; revert on failure.
      const prev = state.collectionMap[gameId] ?? null;
      dispatch({ type: 'PATCH_COLLECTION_STATUS', gameId, status });
      try {
        await Collection.add(gameId, status);
      } catch (e) {
        dispatch({ type: 'PATCH_COLLECTION_STATUS', gameId, status: prev });
        throw e;
      }
    },

    async removeCollectionStatus(gameId) {
      const prev = state.collectionMap[gameId] ?? null;
      dispatch({ type: 'PATCH_COLLECTION_STATUS', gameId, status: null });
      try {
        await Collection.removeByGame(gameId);
      } catch (e) {
        dispatch({ type: 'PATCH_COLLECTION_STATUS', gameId, status: prev });
        throw e;
      }
    },

    clearAuthError() { dispatch({ type: 'SET_AUTH_ERROR', error: null }); },
    set(key, value) { dispatch({ type: 'SET', key, value }); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [state.collectionMap]);

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>
        {children}
      </ActionsContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState() { return useContext(StateContext); }
export function useAppActions() { return useContext(ActionsContext); }
