// state.js — All global state variables
let currentView = "auth";       // auth | browse | collection | game-detail | log-play | history
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

// Collection
let collectionItems = [];
let collectionFilter = "all";   // all | owned | played | wishlist

// Plays
let plays = [];
let buddies = [];

// BGG search
let bggSearchResults = [];
