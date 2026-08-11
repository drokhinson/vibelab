// Actions factory. Screens call these — never fetch() or supabase directly.
// Built once per provider mount against a stateRef so callbacks always read
// live state without re-memoizing on every dispatch.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/client';
import { supabase } from '../auth/supabase';
import { signInWithGoogleOAuth } from '../auth/oauth';
import { ACTIONS as A } from './initialState';
import cache from './cache';
import { applyLocalStatus, refreshCollection } from '../offline/collectionStore';
import { clearOutbox } from '../offline/playOutbox';

// Offline cold-start keys: the cached profile unlocks the Play/Profile tabs
// when the profile fetch can't reach the server; the host seeds keep Gather's
// player/recents suggestions working with zero network.
export const PROFILE_CACHE_KEY = 'bgb:profile:v1';
export const HOST_SEEDS_KEY = 'bgb:hostSeeds:v1';

const BUNDLE_TTL_MS = 10 * 60 * 1000;

export function buildActions(dispatch, stateRef) {
  return {
    // ── Auth ───────────────────────────────────────────────────────────
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
      cache.invalidate('');
      clearOutbox();
      AsyncStorage.multiRemove([PROFILE_CACHE_KEY, HOST_SEEDS_KEY]).catch(() => {});
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

    // ── Feed ───────────────────────────────────────────────────────────
    async refreshFeed() {
      dispatch({ type: A.SET_FEED_LOADING, value: true });
      try {
        const f = await api.feed();
        dispatch({ type: A.SET_FEED, feed: f, cursor: f?.next_cursor });
      } catch {
        dispatch({ type: A.SET_FEED_LOADING, value: false });
      }
    },
    async loadMoreFeed() {
      const { feedCursor, feedLoading } = stateRef.current;
      if (!feedCursor || feedLoading) return;
      dispatch({ type: A.SET_FEED_LOADING, value: true });
      try {
        const f = await api.feed({ cursor: feedCursor });
        dispatch({ type: A.APPEND_FEED, feed: f, cursor: f?.next_cursor });
      } catch {
        dispatch({ type: A.SET_FEED_LOADING, value: false });
      }
    },

    // ── Collection — the one place shelf status flips, app-wide ────────
    async setCollectionStatus(gameId, status, gameSummary) {
      const prev = stateRef.current.myCollectionMap[gameId] || null;
      dispatch({ type: A.SET_COLLECTION_STATUS, gameId, status });
      applyLocalStatus(gameId, status, gameSummary); // offline store keeps up
      try {
        if (!status) await api.removeFromCollection(gameId);
        else if (prev && prev !== 'played') await api.updateCollection(gameId, status);
        else await api.addToCollection(gameId, status);
        cache.invalidate('collection');
        refreshCollection(); // background reconcile
      } catch (e) {
        dispatch({ type: A.SET_COLLECTION_STATUS, gameId, status: prev });
        applyLocalStatus(gameId, prev, gameSummary);
        throw e;
      }
    },

    // ── Game bundles (TTL-cached in global state) ──────────────────────
    async loadGameBundle(gameId, { force = false } = {}) {
      const hit = stateRef.current.gameBundles[gameId];
      if (!force && hit && Date.now() - hit.at < BUNDLE_TTL_MS) return hit.bundle;
      const bundle = await api.gameBundle(gameId);
      dispatch({ type: A.CACHE_GAME_BUNDLE, gameId, bundle });
      return bundle;
    },

    // ── After a play is saved (host settle / quick log) ────────────────
    afterPlaySaved(gameId) {
      cache.invalidate('plays');
      cache.invalidate('profile');
      if (gameId) dispatch({ type: A.DROP_GAME_BUNDLE, gameId });
      // Feed + stats refresh in the background; screens keep rendering
      // current data meanwhile.
      this.refreshFeed();
      api.myStats().then(
        (s) => dispatch({ type: A.SET_STATS, stats: s }),
        () => {},
      );
    },

    // ── Host seeds (Gather pickers) ────────────────────────────────────
    async refreshHostSeeds() {
      try {
        const [games, accounts, ghosts, recent] = await Promise.all([
          api.recentlyPlayedGames().catch(() => []),
          api.buddies().catch(() => []),
          api.ghostPlayers().catch(() => []),
          api.playedWith().catch(() => []),
        ]);
        const partners = { accounts: accounts || [], ghosts: ghosts || [], recent: recent || [] };
        dispatch({ type: A.SET_HOST_SEEDS, games, partners });
        AsyncStorage.setItem(HOST_SEEDS_KEY, JSON.stringify({ games, partners })).catch(() => {});
      } catch {}
    },

    setActiveSession(session) {
      dispatch({ type: A.SET_ACTIVE_SESSION, session });
    },

    dispatch,
  };
}

export function normUser(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    display_name: raw.display_name,
    username: raw.username,
    avatar: raw.avatar || null,
    is_admin: !!raw.is_admin,
  };
}
