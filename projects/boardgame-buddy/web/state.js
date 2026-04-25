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
let hiddenChunks = [];          // chunks the user has hidden for this game
let chunkTypeCache = null;      // [{id,label,icon,display_order}] fetched once
let guideReorderMode = false;   // true while user is in press-and-hold reorder mode

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

// Active in-progress play session (mirrors the server draft row).
let activeSession = null;          // PlayDraftResponse | null
let sessionExpanded = false;       // bubble visible vs. collapsed into FAB
let sessionSaveTimer = null;       // debounce handle for PUT /plays/draft

// BGG search
let bggSearchResults = [];
