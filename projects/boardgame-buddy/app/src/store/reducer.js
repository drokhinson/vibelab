import { initialState, ACTIONS as A } from './initialState';

export function reducer(state, action) {
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
        ...initialState,
        authReady: true, // auth already resolved; we're just signed out now
        chapterTypes: state.chapterTypes, // lookup data isn't user-scoped
      };
    case A.SET_BECOME_ADMIN:
      return { ...state, becomeAdminBusy: !!action.busy, becomeAdminError: action.error || null };

    case A.BOOTSTRAP_LOADED: {
      const p = action.payload || {};
      const pb = p.profile_bundle || {};
      const now = Date.now();
      const bundles = {};
      for (const [id, bundle] of Object.entries(p.game_detail_bundles || {})) {
        bundles[id] = { bundle, at: now };
      }
      return {
        ...state,
        bootstrapped: true,
        feed: p.feed_first_page || state.feed,
        feedCursor: p.feed_cursor || null,
        myCollectionMap: pb.status_map || state.myCollectionMap,
        expansionCounts: pb.expansion_counts || state.expansionCounts,
        stats: pb.stats || state.stats,
        profileBundle: p.profile_bundle || state.profileBundle,
        gameBundles: { ...state.gameBundles, ...bundles },
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
      return {
        ...state,
        gameBundles: { ...state.gameBundles, [action.gameId]: { bundle: action.bundle, at: Date.now() } },
      };
    case A.DROP_GAME_BUNDLE: {
      if (!state.gameBundles[action.gameId]) return state;
      const bundles = { ...state.gameBundles };
      delete bundles[action.gameId];
      return { ...state, gameBundles: bundles };
    }
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
