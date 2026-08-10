// Provider + three contexts (state / dispatch / actions) so screens that only
// dispatch or act don't re-render on read changes. A stateRef keeps live state
// readable from actions and non-React code.
//
// Boot order (speed contract):
//   1. hydrate the offline collection from AsyncStorage — search works
//      immediately, even offline
//   2. resolve the Supabase session (authReady gates the nav tree)
//   3. one GET /bootstrap seeds feed/stats/collection-map for first paint
//   4. background: refresh the offline collection from the network

import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, setAuthTokenGetter } from '../api/client';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { initialState, ACTIONS as A } from './initialState';
import { reducer } from './reducer';
import { buildActions, normUser } from './actions';
import { hydrateCollection, refreshCollection, clearCollection } from '../offline/collectionStore';

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
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo(() => buildActions(dispatch, stateRef), []);

  // Offline collection hydrates before anything network-bound.
  useEffect(() => {
    hydrateCollection();
  }, []);

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
  // profile (auto-create on 404). Only a definitive SIGNED_OUT clears state —
  // a transient null session from a wake-up refresh must not nuke the app.
  useEffect(() => {
    if (!isAuthConfigured || !supabase) {
      dispatch({ type: A.SET_AUTH_READY, value: true });
      return undefined;
    }
    let cancelled = false;

    async function hydrate(session) {
      if (!session) return;
      try {
        const profile = await api.getProfile();
        if (cancelled) return;
        dispatch({ type: A.SET_CURRENT_USER, user: normUser(profile) });
      } catch (e) {
        if (e.status === 404) {
          try {
            const created = await api.upsertProfile(session.user?.email?.split('@')[0] || 'Player');
            if (!cancelled) dispatch({ type: A.SET_CURRENT_USER, user: normUser(created) });
          } catch (e2) {
            if (!cancelled) dispatch({ type: A.SET_AUTH_ERROR, error: `Profile creation failed: ${e2.message}` });
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

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      dispatch({ type: A.SET_SESSION, session });
      if (event === 'SIGNED_OUT') {
        clearCollection();
        dispatch({ type: A.CLEAR_AUTH });
      } else {
        hydrate(session);
      }
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  // Bootstrap seed: once currentUser lands, one GET /bootstrap warms first
  // paint, and the offline collection refreshes in the background.
  const currentUserId = state.currentUser?.id;
  useEffect(() => {
    if (!currentUserId || state.bootstrapped) return undefined;
    let cancelled = false;
    api.bootstrap().then(
      (payload) => {
        if (cancelled) return;
        dispatch({ type: A.BOOTSTRAP_LOADED, payload });
        refreshCollection();
      },
      () => {
        if (cancelled) return;
        // Fallback: pull the essentials individually.
        api.feed().then((f) => !cancelled && dispatch({ type: A.SET_FEED, feed: f, cursor: f?.next_cursor }), () => {});
        api.myStats().then((s) => !cancelled && dispatch({ type: A.SET_STATS, stats: s }), () => {});
        refreshCollection().then((col) => {
          if (cancelled || !col) return;
          const map = {};
          col.items.forEach((it) => {
            if (it.status) map[it.game_id] = it.status;
          });
          dispatch({ type: A.SET_COLLECTION_MAP, map });
        });
      },
    );
    // Chapter types (lookup) — cheap, load once.
    api.chapterTypes().then((t) => !cancelled && dispatch({ type: A.SET_CHAPTER_TYPES, types: t }), () => {});
    return () => {
      cancelled = true;
    };
  }, [currentUserId, state.bootstrapped]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export { A as ACTIONS };
