// src/store/AppContext.js — global app state via Context + useReducer.
//
// Split read/write contexts: components read state from useAppState() and call
// actions from useAppActions(). Mirrors the web store.js keys (session, user,
// feed, activePlay, search) that later phases will populate.
//
// Auth lifecycle (ported from web init.js):
//   - Subscribe to supabase.auth.onAuthStateChange.
//   - On a real session, load GET /profile (resiliently — a transient network
//     hiccup keeps the session and retries rather than forcing a sign-out).
//   - Only an explicit SIGNED_OUT (or AUTH_FAILED on profile load) clears state.

import React, {
  createContext, useContext, useEffect, useMemo, useReducer, useRef,
} from 'react';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { signInWithGoogleOAuth } from '../auth/oauth';
import { api } from '../api/client';

export const initialState = {
  // Auth
  authReady: false, // true once the initial session check has resolved
  authBusy: false, // an email/oauth action is in flight
  authError: null,
  session: null,
  currentUser: null, // BGB profile row (null = signed out OR onboarding)
  needsOnboarding: false, // signed in but no profile display_name yet

  // Populated by later phases
  feed: null,
  feedCursor: null,
  activePlay: null,
  search: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_AUTH_READY':
      return { ...state, authReady: true };
    case 'SET_AUTH_BUSY':
      return { ...state, authBusy: action.value, authError: action.value ? null : state.authError };
    case 'SET_AUTH_ERROR':
      return { ...state, authError: action.error, authBusy: false };
    case 'SET_SESSION':
      return { ...state, session: action.session };
    case 'SET_USER':
      return {
        ...state,
        currentUser: action.user,
        needsOnboarding: action.needsOnboarding ?? false,
      };
    case 'SIGN_OUT':
      return {
        ...initialState,
        authReady: true,
      };
    case 'SET':
      return { ...state, [action.key]: action.value };
    default:
      return state;
  }
}

const StateContext = createContext(initialState);
const ActionsContext = createContext({});

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Keep a ref so async callbacks read fresh session without re-subscribing.
  const sessionRef = useRef(null);

  // Load the BGB profile for the signed-in user. Resilient: a network blip
  // returns 'deferred' (keep session, retry) while a 401/403 returns 'failed'
  // (the token is genuinely bad → sign out).
  async function loadProfile() {
    try {
      const profile = await api.get('/profile');
      const hasName = !!(profile && profile.display_name);
      dispatch({ type: 'SET_USER', user: profile || null, needsOnboarding: !hasName });
      return 'ok';
    } catch (e) {
      if (e && (e.status === 401 || e.status === 403)) return 'failed';
      if (e && e.status === 404) {
        // No profile row yet → onboarding.
        dispatch({ type: 'SET_USER', user: null, needsOnboarding: true });
        return 'ok';
      }
      return 'deferred';
    }
  }

  async function applySession(session) {
    sessionRef.current = session;
    dispatch({ type: 'SET_SESSION', session });
    if (!session) {
      dispatch({ type: 'SET_USER', user: null, needsOnboarding: false });
      return;
    }
    let outcome = await loadProfile();
    // One short backoff retry on a deferred (transient) failure before giving up.
    if (outcome === 'deferred') {
      await new Promise((r) => setTimeout(r, 800));
      outcome = await loadProfile();
    }
    if (outcome === 'failed') {
      try { await supabase.auth.signOut(); } catch {}
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
      } catch {
        // ignore — listener below will catch subsequent changes
      } finally {
        if (active) dispatch({ type: 'SET_AUTH_READY' });
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'SIGNED_OUT') {
        sessionRef.current = null;
        dispatch({ type: 'SIGN_OUT' });
        return;
      }
      // A wake-up TOKEN_REFRESHED while already signed in shouldn't re-run the
      // whole profile load — only (re)apply when the user identity changes.
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
      // When email confirmation is on, there's no session yet.
      const needsConfirm = !(data && data.session);
      return { ok: true, needsConfirm };
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
      dispatch({ type: 'SIGN_OUT' });
    },

    async refreshProfile() {
      return loadProfile();
    },

    clearAuthError() {
      dispatch({ type: 'SET_AUTH_ERROR', error: null });
    },

    set(key, value) {
      dispatch({ type: 'SET', key, value });
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>
        {children}
      </ActionsContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState() {
  return useContext(StateContext);
}

export function useAppActions() {
  return useContext(ActionsContext);
}
