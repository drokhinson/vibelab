// state.js — All global state variables
let currentView = "auth";       // auth | closet | browse | game-detail | log-play | history
let session = null;             // Supabase auth session
let currentUser = null;         // { user_id, display_name }
let supabaseClient = null;      // Supabase JS client

// Games
let gamesCache = [];            // current page of games
let gamesTotalCount = 0;
let gamesPage = 1;
let gamesSearch = "";
let gamesPerPage = 24;

// Current game detail
let currentGame = null;
let currentGuideChunks = [];    // ordered list of ChunkResponse displayed as the guide
let chunkLibrary = [];          // all chunks for currentGame (in the manager modal)
let chunkTypeCache = null;      // [{id,label,icon,display_order}] fetched once

// Closet (user collection)
let collectionItems = [];
let closetView = localStorage.getItem("bgb_closet_view") || "shelves";  // shelves | list
let closetSort = localStorage.getItem("bgb_closet_sort") || "alphabetical"; // alphabetical | last_played
let closetSearch = "";
let closetTab = "collection"; // collection | wishlist

// Plays
let plays = [];
let buddies = [];

// BGG search
let bggSearchResults = [];
