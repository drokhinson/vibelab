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
import { AppState, InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, setAuthTokenGetter } from '../api/client';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { initialState, ACTIONS as A } from './initialState';
import { reducer, EXPECTED_BOOTSTRAP_VERSION } from './reducer';
import cache from './cache';
import { buildActions, normUser, PROFILE_CACHE_KEY, HOST_SEEDS_KEY } from './actions';
import { hydrateCollection, refreshCollection, clearCollection } from '../offline/collectionStore';
import { clearOutbox, flushOutbox, hydrateOutbox } from '../offline/playOutbox';
import * as net from '../offline/net';

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

  // Offline stores hydrate before anything network-bound: the collection
  // (search), the play outbox (pending uploads), and the host seeds
  // (Gather's player/recents suggestions).
  useEffect(() => {
    hydrateCollection();
    hydrateOutbox();
    AsyncStorage.getItem(HOST_SEEDS_KEY)
      .then((raw) => {
        if (!raw) return;
        const { games, partners } = JSON.parse(raw);
        dispatch({ type: A.SET_HOST_SEEDS, games: games || [], partners: partners || undefined });
      })
      .catch(() => {});
  }, []);

  // Keep the profile cache fresh so an offline cold start can still unlock
  // the Play/Profile tabs (cleared on sign-out in actions.signOut).
  const currentUser = state.currentUser;
  useEffect(() => {
    if (currentUser) {
      AsyncStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(currentUser)).catch(() => {});
    }
  }, [currentUser]);

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
        } else if (e.status == null) {
          // Network failure with a live Supabase session — fall back to the
          // cached profile so an offline cold start can still record plays.
          try {
            const raw = await AsyncStorage.getItem(PROFILE_CACHE_KEY);
            const cached = raw ? JSON.parse(raw) : null;
            if (!cancelled && cached?.id === session.user?.id) {
              dispatch({ type: A.SET_CURRENT_USER, user: cached });
              return;
            }
          } catch {}
          if (!cancelled) dispatch({ type: A.SET_AUTH_ERROR, error: `Couldn't load your profile: ${e.message}` });
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
        clearOutbox();
        AsyncStorage.multiRemove([PROFILE_CACHE_KEY, HOST_SEEDS_KEY]).catch(() => {});
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

  // Outbox flush: whenever we're plausibly back online — sign-in resolved,
  // or the app returns to the foreground — drain any plays recorded offline
  // (sauceboss attachAppStateListener pattern). Flushed plays run the same
  // invalidation as a live save so feed/plays/stats catch up.
  const flushUserId = state.currentUser?.id;
  useEffect(() => {
    if (!flushUserId) return undefined;
    const runFlush = async () => {
      try {
        const { flushed } = await flushOutbox();
        for (const f of flushed) actions.afterPlaySaved(f.gameId);
      } catch {}
    };
    runFlush();
    // This is the composition root: net.js is a leaf that knows how to count
    // evidence but not how to check or what to do about it, so both halves get
    // wired here. The reconnect edge is the trigger the app was missing — it
    // used to drain only on sign-in and foreground, so signal returning while
    // the user sat on the Feed left the queue parked.
    net.setProbe(() => api.health());
    net.onReconnect(runFlush);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        // Whatever we learned before the phone went in a pocket is stale; let
        // the next real request re-decide rather than showing the banner over
        // a connection that came back while we weren't looking.
        net.resetEvidence();
        runFlush();
      }
    });
    return () => {
      sub?.remove?.();
      net.onReconnect(null);
    };
  }, [flushUserId, actions]);

  // Bootstrap seed: once currentUser lands, one GET /bootstrap warms first
  // paint, and the offline collection refreshes in the background.
  const currentUserId = state.currentUser?.id;
  useEffect(() => {
    if (!currentUserId || state.bootstrapped) return undefined;
    let cancelled = false;
    api.bootstrap().then(
      (payload) => {
        if (cancelled) return;
        if (payload?.bootstrap_version != null && payload.bootstrap_version !== EXPECTED_BOOTSTRAP_VERSION) {
          cache.invalidate(''); // server shape changed — don't mix two shapes
        }
        dispatch({ type: A.BOOTSTRAP_LOADED, payload });
        refreshCollection();
        // Second stage: the per-owned-game detail bundles. Deferred until
        // after the first screen has settled — nothing on it reads them, and
        // Game Detail force-fetches its own bundle on a miss anyway.
        InteractionManager.runAfterInteractions(() => {
          if (cancelled) return;
          api.bootstrapGameBundles().then(
            (r) => !cancelled && dispatch({ type: A.SEED_GAME_BUNDLES, bundles: r?.game_detail_bundles }),
            () => {},
          );
        });
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
