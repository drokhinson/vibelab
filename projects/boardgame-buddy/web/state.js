// state.js — All global state variables
let currentView = "auth";       // auth | browse | closet | game-detail | log-play | history | import | pending-guides | profile
let session = null;             // Supabase auth session
let currentUser = null;         // { user_id, display_name, is_admin }
let supabaseClient = null;      // Supabase JS client

// Games
let gamesCache = [];            // current page of games
let gamesTotalCount = 0;
let gamesPage = 1;
let gamesSearch = "";
let gamesPerPage = 12;

// Current game detail
let currentGame = null;
let currentGuideChunks = [];    // visible chunks (MyGuideChunkResponse) in render order
let hiddenChunks = [];          // chunks shown in the Hidden / available panel
                                // (explicitly hidden + non-default chunks the
                                //  user hasn't added yet, in custom mode)
let hasGuideCustomizations = false; // true if the user has any selection rows
                                    // for the current game; drives Restore button
                                    // visibility and the panel's existence
let chunkTypeCache = null;      // [{id,label,icon,display_order}] fetched once
let currentExpansions = [];     // [{expansion_game_id, name, color, is_enabled, chunk_count, ...}]
let allGuideChunks = [];        // cache of every linked-expansion chunk;
                                // currentGuideChunks / hiddenChunks are derived

// Closet (user collection) — shelves are paginated server-side.
let shelfItems = { owned: [], played: [] };
let shelfPage = { owned: 1, played: 1 };
let shelfTotal = { owned: 0, played: 0 };
let shelfHasMore = { owned: true, played: true };
let shelfLoading = { owned: false, played: false };
const SHELF_PER_PAGE = 20;
let wishlistItems = [];
let closetView = localStorage.getItem("bgb_closet_view") || "list";  // list | shelves  (default: list)
let closetSort = localStorage.getItem("bgb_closet_sort") || "alphabetical"; // alphabetical | last_played
let closetSearch = "";
let closetTab = "collection"; // collection | wishlist

// Plays
let plays = [];
let buddies = [];
let playsPage = 1;
let playsTotalCount = 0;
const PLAYS_PER_PAGE = 20;
let playsFilterGameId = null;
let playsFilterBuddyId = null;
let playsFilterOptions = null;  // { games: [{id, name}], buddies: [{id, name}] }

// Browse filters
let gamesFilterPlayers = null;
let gamesFilterPlaytimeMin = null;
let gamesFilterPlaytimeMax = null;
let gamesFilterMechanics = [];
let mechanicsOptions = [];
let gamesFilterOwnedOnly = false;

// Profile (account page tab state — survives re-renders)
let profileTab = "account"; // account | buddies

// Active in-progress play session (mirrors the server draft row).
let activeSession = null;          // PlayDraftResponse | null
let sessionExpanded = false;       // bubble visible vs. collapsed into FAB
let sessionSaveTimer = null;       // debounce handle for PUT /plays/draft
let sessionDirty = false;          // true once the user has actually mutated the session
let sessionShowingGuide = false;   // true when the session bubble is overlaid by the in-place guide

// Quick Reference guide UI state — survives chunk re-renders so a search/filter
// in progress isn't wiped by recomputeGuideViews().
let guideTypeFilter = null;        // null = all types, otherwise chunk_type id ('setup', 'scoring', ...)
let guideSearchQuery = "";         // case-insensitive substring search

// BGG search
let bggSearchResults = [];
