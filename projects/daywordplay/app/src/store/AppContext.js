// Central app state — mirrors web/state.js shape. Reducer + provider with
// split read/write contexts so screens that only dispatch don't re-render
// when read state changes.

import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { CACHE_TTL_MS } from '#shared/constants';
import { api, setAdminKey } from '../api/client';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { signInWithGoogleOAuth, handleAuthDeepLink } from '../auth/google';

// ── Initial state ─────────────────────────────────────────────────────────
export const initialState = {
  authReady: false,
  authBusy: false,
  authError: null,
  session: null,
  currentUser: null,

  myGroups: [],
  activeGroupId: null,
  groupsLoaded: false,

  todayByGroup: {},          // groupId → today payload
  yesterdayByGroup: {},      // groupId → yesterday payload
  leaderboardByGroup: {},    // groupId → leaderboard payload
  reusableSentences: [],     // for active group only
  todayLoading: false,
  yesterdayLoading: false,
  leaderboardLoading: false,

  bookmarks: [],
  allWords: [],
  playedWords: [],
  bookmarksLoaded: false,
  allWordsLoaded: false,
  playedWordsLoaded: false,

  pendingJoinRequests: [],   // [{ groupId, requests: [...] }]

  searchResults: [],
  searchLoading: false,

  proposals: [],
  adminGroups: [],
  adminAuthed: false,
};

// ── Action types ──────────────────────────────────────────────────────────
const A = {
  AUTH_READY: 'AUTH_READY',
  SET_SESSION: 'SET_SESSION',
  SET_PROFILE: 'SET_PROFILE',
  SET_AUTH_BUSY: 'SET_AUTH_BUSY',
  SET_AUTH_ERROR: 'SET_AUTH_ERROR',
  CLEAR_USER: 'CLEAR_USER',

  SET_GROUPS: 'SET_GROUPS',
  SET_ACTIVE_GROUP: 'SET_ACTIVE_GROUP',
  ADD_GROUP: 'ADD_GROUP',
  REMOVE_GROUP: 'REMOVE_GROUP',

  SET_TODAY: 'SET_TODAY',
  SET_TODAY_LOADING: 'SET_TODAY_LOADING',
  SET_REUSABLE_SENTENCES: 'SET_REUSABLE_SENTENCES',
  SET_YESTERDAY: 'SET_YESTERDAY',
  SET_YESTERDAY_LOADING: 'SET_YESTERDAY_LOADING',
  PATCH_VOTE: 'PATCH_VOTE',
  SET_LEADERBOARD: 'SET_LEADERBOARD',
  SET_LEADERBOARD_LOADING: 'SET_LEADERBOARD_LOADING',

  SET_BOOKMARKS: 'SET_BOOKMARKS',
  SET_ALL_WORDS: 'SET_ALL_WORDS',
  SET_PLAYED_WORDS: 'SET_PLAYED_WORDS',
  TOGGLE_BOOKMARK: 'TOGGLE_BOOKMARK',

  SET_JOIN_REQUESTS: 'SET_JOIN_REQUESTS',

  SET_SEARCH_RESULTS: 'SET_SEARCH_RESULTS',
  SET_SEARCH_LOADING: 'SET_SEARCH_LOADING',

  SET_PROPOSALS: 'SET_PROPOSALS',
  SET_ADMIN_GROUPS: 'SET_ADMIN_GROUPS',
  SET_ADMIN_AUTHED: 'SET_ADMIN_AUTHED',
};

function reducer(state, action) {
  switch (action.type) {
    case A.AUTH_READY:
      return { ...state, authReady: true };
    case A.SET_SESSION:
      return { ...state, session: action.session };
    case A.SET_PROFILE:
      return { ...state, currentUser: action.profile };
    case A.SET_AUTH_BUSY:
      return { ...state, authBusy: !!action.busy };
    case A.SET_AUTH_ERROR:
      return { ...state, authError: action.error || null };
    case A.CLEAR_USER:
      return {
        ...initialState,
        authReady: true,
      };

    case A.SET_GROUPS:
      return { ...state, myGroups: action.groups, groupsLoaded: true };
    case A.SET_ACTIVE_GROUP:
      return { ...state, activeGroupId: action.groupId };
    case A.ADD_GROUP: {
      const existing = state.myGroups.find((g) => g.id === action.group.id);
      if (existing) return state;
      return { ...state, myGroups: [...state.myGroups, action.group] };
    }
    case A.REMOVE_GROUP: {
      const groups = state.myGroups.filter((g) => g.id !== action.groupId);
      const activeGroupId = state.activeGroupId === action.groupId
        ? (groups[0]?.id || null)
        : state.activeGroupId;
      const todayByGroup = { ...state.todayByGroup };
      const yesterdayByGroup = { ...state.yesterdayByGroup };
      const leaderboardByGroup = { ...state.leaderboardByGroup };
      delete todayByGroup[action.groupId];
      delete yesterdayByGroup[action.groupId];
      delete leaderboardByGroup[action.groupId];
      return { ...state, myGroups: groups, activeGroupId, todayByGroup, yesterdayByGroup, leaderboardByGroup };
    }

    case A.SET_TODAY:
      return {
        ...state,
        todayByGroup: { ...state.todayByGroup, [action.groupId]: cacheEntry(action.data) },
      };
    case A.SET_TODAY_LOADING:
      return { ...state, todayLoading: !!action.loading };
    case A.SET_REUSABLE_SENTENCES:
      return { ...state, reusableSentences: action.list || [] };
    case A.SET_YESTERDAY:
      return {
        ...state,
        yesterdayByGroup: { ...state.yesterdayByGroup, [action.groupId]: cacheEntry(action.data) },
      };
    case A.SET_YESTERDAY_LOADING:
      return { ...state, yesterdayLoading: !!action.loading };
    case A.PATCH_VOTE: {
      const entry = state.yesterdayByGroup[action.groupId];
      if (!entry) return state;
      const sentences = (entry.data.sentences || []).map((s) =>
        s.id === action.sentenceId ? { ...s, vote_count: (s.vote_count || 0) + 1, i_voted: true } : s,
      ).sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
      const next = { ...entry.data, sentences, has_voted: true };
      return {
        ...state,
        yesterdayByGroup: { ...state.yesterdayByGroup, [action.groupId]: cacheEntry(next) },
      };
    }
    case A.SET_LEADERBOARD:
      return {
        ...state,
        leaderboardByGroup: { ...state.leaderboardByGroup, [action.groupId]: cacheEntry(action.data) },
      };
    case A.SET_LEADERBOARD_LOADING:
      return { ...state, leaderboardLoading: !!action.loading };

    case A.SET_BOOKMARKS:
      return { ...state, bookmarks: action.list || [], bookmarksLoaded: true };
    case A.SET_ALL_WORDS:
      return { ...state, allWords: action.list || [], allWordsLoaded: true };
    case A.SET_PLAYED_WORDS:
      return { ...state, playedWords: action.list || [], playedWordsLoaded: true };
    case A.TOGGLE_BOOKMARK: {
      const isBookmarked = state.bookmarks.some((w) => w.id === action.word.id);
      const bookmarks = isBookmarked
        ? state.bookmarks.filter((w) => w.id !== action.word.id)
        : [action.word, ...state.bookmarks];
      return { ...state, bookmarks };
    }

    case A.SET_JOIN_REQUESTS:
      return { ...state, pendingJoinRequests: action.list || [] };

    case A.SET_SEARCH_RESULTS:
      return { ...state, searchResults: action.list || [] };
    case A.SET_SEARCH_LOADING:
      return { ...state, searchLoading: !!action.loading };

    case A.SET_PROPOSALS:
      return { ...state, proposals: action.list || [] };
    case A.SET_ADMIN_GROUPS:
      return { ...state, adminGroups: action.list || [] };
    case A.SET_ADMIN_AUTHED:
      return { ...state, adminAuthed: !!action.authed };

    default:
      return state;
  }
}

function cacheEntry(data) {
  return { data, ts: Date.now() };
}

function isFresh(entry) {
  return !!(entry && entry.data && Date.now() - entry.ts < CACHE_TTL_MS);
}

export function getCachedToday(state, groupId) {
  const entry = state.todayByGroup[groupId];
  return isFresh(entry) ? entry.data : null;
}
export function getCachedYesterday(state, groupId) {
  const entry = state.yesterdayByGroup[groupId];
  return isFresh(entry) ? entry.data : null;
}
export function getCachedLeaderboard(state, groupId) {
  const entry = state.leaderboardByGroup[groupId];
  return isFresh(entry) ? entry.data : null;
}

// ── Contexts ──────────────────────────────────────────────────────────────
const StateContext = createContext(initialState);
const DispatchContext = createContext(() => {});
const ActionsContext = createContext({});

export function useAppState() { return useContext(StateContext); }
export function useAppDispatch() { return useContext(DispatchContext); }
export function useAppActions() { return useContext(ActionsContext); }

// ── Provider ──────────────────────────────────────────────────────────────
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const actions = useMemo(() => buildActions(dispatch, stateRef), []);

  // Subscribe to Supabase auth changes once at mount.
  useEffect(() => {
    if (!isAuthConfigured || !supabase) {
      dispatch({ type: A.AUTH_READY });
      return undefined;
    }
    let active = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        dispatch({ type: A.SET_SESSION, session: data?.session || null });
        if (data?.session) {
          await actions.bootForSession(data.session);
        }
      } finally {
        if (active) dispatch({ type: A.AUTH_READY });
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (!active) return;
      dispatch({ type: A.SET_SESSION, session: sess || null });
      if (sess) {
        actions.bootForSession(sess).catch(() => {});
      } else if (event === 'SIGNED_OUT') {
        dispatch({ type: A.CLEAR_USER });
      }
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, [actions]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ActionsContext.Provider value={actions}>
          {children}
        </ActionsContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

// ── Action creators ───────────────────────────────────────────────────────
function buildActions(dispatch, stateRef) {
  async function bootForSession(session) {
    try {
      let profile;
      try {
        profile = await api.getProfile();
      } catch (err) {
        const msg = err?.message || '';
        const isMissing = err?.status === 404 || /404/.test(msg) || /not found/i.test(msg);
        if (!isMissing) throw err;
        const email = session?.user?.email || '';
        const displayName = email.split('@')[0] || 'Player';
        await api.upsertProfile(displayName);
        profile = await api.getProfile();
      }
      dispatch({ type: A.SET_PROFILE, profile });
      await loadGroups();
    } catch (err) {
      dispatch({ type: A.SET_AUTH_ERROR, error: err?.message || 'Failed to load profile.' });
      try { await supabase?.auth?.signOut(); } catch {}
    }
  }

  async function signInWithEmail(email, password) {
    if (!supabase) return { ok: false, error: 'Sign-in not configured.' };
    dispatch({ type: A.SET_AUTH_BUSY, busy: true });
    dispatch({ type: A.SET_AUTH_ERROR, error: null });
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return { ok: true };
    } catch (err) {
      const msg = err?.message || 'Sign-in failed.';
      dispatch({ type: A.SET_AUTH_ERROR, error: msg });
      return { ok: false, error: msg };
    } finally {
      dispatch({ type: A.SET_AUTH_BUSY, busy: false });
    }
  }

  async function signUpWithEmail(email, password) {
    if (!supabase) return { ok: false, error: 'Sign-in not configured.' };
    dispatch({ type: A.SET_AUTH_BUSY, busy: true });
    dispatch({ type: A.SET_AUTH_ERROR, error: null });
    try {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      // If email confirmation is off, signUp returns a session immediately.
      if (data?.session) return { ok: true };
      return { ok: true, message: 'Check your email to confirm your account, then log in.' };
    } catch (err) {
      const msg = err?.message || 'Sign-up failed.';
      dispatch({ type: A.SET_AUTH_ERROR, error: msg });
      return { ok: false, error: msg };
    } finally {
      dispatch({ type: A.SET_AUTH_BUSY, busy: false });
    }
  }

  async function signInWithGoogle() {
    dispatch({ type: A.SET_AUTH_BUSY, busy: true });
    dispatch({ type: A.SET_AUTH_ERROR, error: null });
    try {
      const result = await signInWithGoogleOAuth();
      if (!result.ok && !result.cancelled) {
        dispatch({ type: A.SET_AUTH_ERROR, error: result.error || 'Google sign-in failed.' });
      }
      return result;
    } finally {
      dispatch({ type: A.SET_AUTH_BUSY, busy: false });
    }
  }

  async function signOut() {
    setAdminKey(null);
    if (supabase) {
      try { await supabase.auth.signOut(); } catch {}
    }
    dispatch({ type: A.CLEAR_USER });
  }

  async function deleteAccount() {
    try {
      await api.deleteProfile();
    } catch {
      // Swallow — sign out anyway so the app returns to a clean state.
    }
    return signOut();
  }

  // ── Groups ──
  async function loadGroups() {
    try {
      const groups = await api.getMyGroups();
      dispatch({ type: A.SET_GROUPS, groups });
      const cur = stateRef.current.activeGroupId;
      const stillExists = cur && groups.some((g) => g.id === cur);
      if (!stillExists) {
        dispatch({ type: A.SET_ACTIVE_GROUP, groupId: groups[0]?.id || null });
      }
      const activeId = stillExists ? cur : (groups[0]?.id || null);
      if (activeId) await loadToday(activeId);
    } catch (err) {
      // surface via authError for visibility — non-fatal
      dispatch({ type: A.SET_AUTH_ERROR, error: err?.message || 'Failed to load groups.' });
    }
  }

  function setActiveGroup(groupId) {
    dispatch({ type: A.SET_ACTIVE_GROUP, groupId });
  }

  async function createGroup(name) {
    const group = await api.createGroup(name);
    dispatch({ type: A.ADD_GROUP, group });
    dispatch({ type: A.SET_ACTIVE_GROUP, groupId: group.id });
    await loadToday(group.id);
    return group;
  }

  async function joinGroupByCode(code) {
    const group = await api.joinGroupByCode(code);
    dispatch({ type: A.ADD_GROUP, group });
    dispatch({ type: A.SET_ACTIVE_GROUP, groupId: group.id });
    await loadToday(group.id);
    return group;
  }

  async function leaveGroup(groupId) {
    await api.leaveGroup(groupId);
    dispatch({ type: A.REMOVE_GROUP, groupId });
  }

  async function searchGroups(q) {
    dispatch({ type: A.SET_SEARCH_LOADING, loading: true });
    try {
      const list = await api.searchGroups(q);
      dispatch({ type: A.SET_SEARCH_RESULTS, list });
    } finally {
      dispatch({ type: A.SET_SEARCH_LOADING, loading: false });
    }
  }

  async function loadJoinRequests() {
    const groups = stateRef.current.myGroups;
    if (!groups.length) {
      dispatch({ type: A.SET_JOIN_REQUESTS, list: [] });
      return;
    }
    const results = await Promise.all(groups.map(async (g) => {
      try {
        const requests = await api.getJoinRequests(g.id);
        return { group: g, requests };
      } catch {
        return { group: g, requests: [] };
      }
    }));
    const list = results.filter((r) => r.requests.length > 0);
    dispatch({ type: A.SET_JOIN_REQUESTS, list });
  }

  async function respondJoinRequest(groupId, requestId, action) {
    await api.respondJoinRequest(groupId, requestId, action);
    const list = stateRef.current.pendingJoinRequests
      .map((entry) => entry.group.id === groupId
        ? { ...entry, requests: entry.requests.filter((r) => r.id !== requestId) }
        : entry,
      )
      .filter((entry) => entry.requests.length > 0);
    dispatch({ type: A.SET_JOIN_REQUESTS, list });
  }

  // ── Word / Sentence / Vote ──
  async function loadToday(groupId, { force = false } = {}) {
    if (!groupId) return null;
    if (!force) {
      const cached = getCachedToday(stateRef.current, groupId);
      if (cached) return cached;
    }
    dispatch({ type: A.SET_TODAY_LOADING, loading: true });
    try {
      const data = await api.getToday(groupId);
      dispatch({ type: A.SET_TODAY, groupId, data });
      return data;
    } finally {
      dispatch({ type: A.SET_TODAY_LOADING, loading: false });
    }
  }

  async function submitSentence(groupId, sentence) {
    const fresh = await api.submitSentence(groupId, sentence);
    dispatch({ type: A.SET_TODAY, groupId, data: fresh });
    return fresh;
  }

  async function loadReusableSentences(groupId) {
    if (!groupId) {
      dispatch({ type: A.SET_REUSABLE_SENTENCES, list: [] });
      return [];
    }
    try {
      const list = await api.getReusableSentences(groupId);
      dispatch({ type: A.SET_REUSABLE_SENTENCES, list });
      return list;
    } catch {
      dispatch({ type: A.SET_REUSABLE_SENTENCES, list: [] });
      return [];
    }
  }

  async function loadYesterday(groupId, { force = false } = {}) {
    if (!groupId) return null;
    if (!force) {
      const cached = getCachedYesterday(stateRef.current, groupId);
      if (cached) return cached;
    }
    dispatch({ type: A.SET_YESTERDAY_LOADING, loading: true });
    try {
      const data = await api.getYesterday(groupId);
      dispatch({ type: A.SET_YESTERDAY, groupId, data });
      return data;
    } finally {
      dispatch({ type: A.SET_YESTERDAY_LOADING, loading: false });
    }
  }

  async function castVote(groupId, sentenceId) {
    await api.voteSentence(sentenceId);
    dispatch({ type: A.PATCH_VOTE, groupId, sentenceId });
  }

  // ── Leaderboard ──
  async function loadLeaderboard(groupId, { force = false } = {}) {
    if (!groupId) return null;
    if (!force) {
      const cached = getCachedLeaderboard(stateRef.current, groupId);
      if (cached) return cached;
    }
    dispatch({ type: A.SET_LEADERBOARD_LOADING, loading: true });
    try {
      const data = await api.getLeaderboard(groupId);
      dispatch({ type: A.SET_LEADERBOARD, groupId, data });
      return data;
    } finally {
      dispatch({ type: A.SET_LEADERBOARD_LOADING, loading: false });
    }
  }

  // ── Dictionary / Bookmarks ──
  async function loadBookmarks() {
    const list = await api.getBookmarks();
    dispatch({ type: A.SET_BOOKMARKS, list });
    return list;
  }
  async function loadAllWords() {
    const list = await api.getAllWords();
    dispatch({ type: A.SET_ALL_WORDS, list });
    return list;
  }
  async function loadPlayedWords() {
    const list = await api.getPlayedWords();
    dispatch({ type: A.SET_PLAYED_WORDS, list });
    return list;
  }
  async function toggleBookmark(word) {
    const { bookmarks } = stateRef.current;
    const isBookmarked = bookmarks.some((w) => w.id === word.id);
    if (isBookmarked) await api.unbookmarkWord(word.id);
    else await api.bookmarkWord(word.id);
    dispatch({ type: A.TOGGLE_BOOKMARK, word });
  }

  async function proposeWord(payload) {
    return api.proposeWord(payload);
  }

  // ── Admin ──
  async function authenticateAdmin(adminKey) {
    setAdminKey(adminKey);
    try {
      // becomeAdmin promotes the *current* user; cheap probe also validates the key.
      await api.becomeAdmin(adminKey);
      dispatch({ type: A.SET_ADMIN_AUTHED, authed: true });
      return { ok: true };
    } catch (err) {
      setAdminKey(null);
      dispatch({ type: A.SET_ADMIN_AUTHED, authed: false });
      return { ok: false, error: err?.message || 'Admin auth failed.' };
    }
  }

  function clearAdmin() {
    setAdminKey(null);
    dispatch({ type: A.SET_ADMIN_AUTHED, authed: false });
  }

  async function loadAdminProposals() {
    const list = await api.adminListProposals();
    dispatch({ type: A.SET_PROPOSALS, list });
    return list;
  }

  async function loadAdminGroups() {
    const list = await api.adminListGroups();
    dispatch({ type: A.SET_ADMIN_GROUPS, list });
    return list;
  }

  return {
    bootForSession,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    signOut,
    deleteAccount,
    handleAuthDeepLink,
    loadGroups,
    setActiveGroup,
    createGroup,
    joinGroupByCode,
    leaveGroup,
    searchGroups,
    loadJoinRequests,
    respondJoinRequest,
    loadToday,
    submitSentence,
    loadReusableSentences,
    loadYesterday,
    castVote,
    loadLeaderboard,
    loadBookmarks,
    loadAllWords,
    loadPlayedWords,
    toggleBookmark,
    proposeWord,
    authenticateAdmin,
    clearAdmin,
    loadAdminProposals,
    loadAdminGroups,
  };
}
