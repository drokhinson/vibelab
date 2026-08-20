// Global state shape. Only app-wide, cross-screen data lives here — paginated
// screen-local lists go through store/cache.js instead.

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
  stats: null,
  profileBundle: null,
  gameBundles: {}, // gameId -> { bundle, at } (TTL-stamped)
  recentlyPlayedGames: [], // host game-picker seed
  playPartners: { accounts: [], ghosts: [], recent: [] }, // host player-picker seed

  // Lookups
  chapterTypes: [],

  // Live session draft (host flow). Persisted to AsyncStorage by playSession model.
  activeSession: null,
};

export const ACTIONS = {
  SET_AUTH_READY: 'SET_AUTH_READY',
  SET_SESSION: 'SET_SESSION',
  SET_CURRENT_USER: 'SET_CURRENT_USER',
  SET_AUTH_BUSY: 'SET_AUTH_BUSY',
  SET_AUTH_ERROR: 'SET_AUTH_ERROR',
  CLEAR_AUTH: 'CLEAR_AUTH',
  SET_BECOME_ADMIN: 'SET_BECOME_ADMIN',

  BOOTSTRAP_LOADED: 'BOOTSTRAP_LOADED',
  SEED_GAME_BUNDLES: 'SEED_GAME_BUNDLES',
  SET_FEED: 'SET_FEED',
  APPEND_FEED: 'APPEND_FEED',
  SET_FEED_LOADING: 'SET_FEED_LOADING',
  SET_COLLECTION_STATUS: 'SET_COLLECTION_STATUS',
  SET_COLLECTION_MAP: 'SET_COLLECTION_MAP',
  SET_STATS: 'SET_STATS',
  CACHE_GAME_BUNDLE: 'CACHE_GAME_BUNDLE',
  DROP_GAME_BUNDLE: 'DROP_GAME_BUNDLE',
  SET_CHAPTER_TYPES: 'SET_CHAPTER_TYPES',
  SET_HOST_SEEDS: 'SET_HOST_SEEDS',
  SET_ACTIVE_SESSION: 'SET_ACTIVE_SESSION',
};
