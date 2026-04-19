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
let currentGuide = null;

// Closet (user collection)
let collectionItems = [];
let closetView = localStorage.getItem("bgb_closet_view") || "shelves";  // shelves | list
let closetSort = localStorage.getItem("bgb_closet_sort") || "alphabetical"; // alphabetical | last_played
let closetSearch = "";

// Plays
let plays = [];
let buddies = [];

// BGG search
let bggSearchResults = [];
